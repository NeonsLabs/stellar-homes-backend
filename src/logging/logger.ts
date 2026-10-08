import { Request, Response, NextFunction } from "express";

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: string;
  context?: Record<string, any>;
}

export class Logger {
  log(level: LogEntry["level"], message: string, context?: Record<string, any>) {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    };
    if (process.env.NODE_ENV !== "test") {
      console.log(JSON.stringify(entry));
    }
  }

  info(msg: string, ctx?: Record<string, any>) { this.log("info", msg, ctx); }
  warn(msg: string, ctx?: Record<string, any>) { this.log("warn", msg, ctx); }
  error(msg: string, ctx?: Record<string, any>) { this.log("error", msg, ctx); }
}

export const logger = new Logger();

export function requestTracing(req: Request, res: Response, next: NextFunction) {
  const reqId = (req.headers["x-request-id"] as string) || `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  (req as any).requestId = reqId;
  res.setHeader("X-Request-ID", reqId);
  next();
}
