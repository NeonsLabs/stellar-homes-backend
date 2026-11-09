import { Router } from "express";
import { Gateway } from "../chain/gateway";

const READY_TIMEOUT_MS = 5000;

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
  router.get("/readyz", async (_req, res) => {
    const timestamp = new Date().toISOString();
    try {
      await Promise.race([
        gateway.read<bigint>("mortgage", "get_grace_secs"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), READY_TIMEOUT_MS).unref()),
      ]);
      res.status(200).json({ ready: true, ledger: gateway.mode, timestamp });
    } catch (err) {
      res.status(503).json({
        ready: false,
        ledger: gateway.mode,
        reason: err instanceof Error ? err.message : "contract read failed",
        timestamp,
      });
    }
  });

  return router;
}
