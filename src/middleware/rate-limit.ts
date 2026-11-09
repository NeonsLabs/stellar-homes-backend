import { Request, Response, NextFunction } from "express";

interface Options {
  /** Paths that are never limited, so probes and uptime checks cannot be locked out. */
  skipPaths?: string[];
}

/**
 * A fixed-window limit per client address.
 *
 * Behind a proxy `req.ip` is the proxy's address unless the app sets
 * `trust proxy`, in which case every visitor would share one limit. createApp
 * sets it, so the address used here is the real client's.
 *
 * Counts live in this process's memory, which is enough for a single instance.
 * Running several would need a shared store such as Redis.
 */
export function rateLimiter(maxRequests = 100, windowMs = 60_000, options: Options = {}) {
  const skip = new Set(options.skipPaths ?? []);
  const requestCounts = new Map<string, { count: number; resetAt: number }>();

  // Without this the map keeps an entry for every address ever seen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of requestCounts) {
      if (now > record.resetAt) requestCounts.delete(ip);
    }
  }, windowMs);
  // Do not keep the process alive, or the test runner and graceful shutdown would hang.
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    if (skip.has(req.path)) return next();

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const record = requestCounts.get(ip);

    if (!record || now > record.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (record.count >= maxRequests) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json({ error: "TooManyRequests", message: "Rate limit exceeded" });
    }

    record.count++;
    next();
  };
}
