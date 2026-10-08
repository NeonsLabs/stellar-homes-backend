import { Router } from "express";
import { Gateway } from "../chain/gateway";

export function createHealthRouter(gateway: Gateway): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "alive", uptime: process.uptime() });
  });

  router.get("/readyz", async (_req, res) => {
    const checks = {
      ledger: gateway.mode,
      ready: true,
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(checks);
  });

  return router;
}
