import { Router } from "express";
import { Gateway } from "../chain/gateway";

// A contract read goes through simulation on the Soroban RPC, which takes about
// three seconds on testnet and occasionally more than five. A shorter limit
// makes the probe flap against a perfectly healthy service.
const READY_TIMEOUT_MS = 12_000;
// A probe that polls every few seconds should not turn into an RPC call each time.
const READY_CACHE_MS = 15_000;

export function createHealthRouter(gateway: Gateway): Router {
  const router = Router();

  // Liveness: the process is up. Says nothing about whether it can do its job.
  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "alive", uptime: process.uptime() });
  });

  // Readiness: can the service actually read the contracts. This makes a real
  // call through the gateway, so an unreachable Soroban RPC or a misconfigured
  // contract id shows up here as a 503 instead of as a healthy-looking service
  // that fails on every request.
  let cached: { at: number; status: number; body: Record<string, unknown> } | null = null;

  router.get("/readyz", async (_req, res) => {
    if (cached && Date.now() - cached.at < READY_CACHE_MS) {
      return res.status(cached.status).json(cached.body);
    }
    const timestamp = new Date().toISOString();
    let status = 200;
    let body: Record<string, unknown> = { ready: true, ledger: gateway.mode, timestamp };
    try {
      await Promise.race([
        gateway.read<bigint>("mortgage", "get_grace_secs"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), READY_TIMEOUT_MS).unref()),
      ]);
    } catch (err) {
      status = 503;
      body = {
        ready: false,
        ledger: gateway.mode,
        reason: err instanceof Error ? err.message : "contract read failed",
        timestamp,
      };
    }
    cached = { at: Date.now(), status, body };
    res.status(status).json(body);
  });

  return router;
}
