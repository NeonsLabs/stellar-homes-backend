import express from "express";
import cors from "cors";
import { createAuditRouter } from "./audit";
import { Gateway, SimulatedGateway, SorobanGateway } from "./chain/gateway";
import { SimulatedLedger } from "./chain/sim/ledger";
import { SorobanClient } from "./chain/soroban";
import { Config } from "./config";
import { MILESTONE_COUNT } from "./chain/sim/registry";
import { errorHandler, jsonReplacer, route } from "./http";
import { createKycRouter } from "./kyc";
import { rateLimiter } from "./middleware/rate-limit";
import { createHealthRouter } from "./routes/health";
import { createAdminRouter } from "./routes/admin";
import { createChainRouter } from "./routes/chain";
import { adminGuard } from "./routes/common";
import { createMortgageRouter } from "./routes/mortgages";
import { createPoolRouter } from "./routes/pool";
import { createPropertyRouter } from "./routes/properties";

export function createGateway(config: Config): Gateway {
  if (config.contracts) {
    return new SorobanGateway(new SorobanClient(config.rpcUrl, config.networkPassphrase, config.contracts));
  }
  return new SimulatedGateway(
    new SimulatedLedger({
      admin: config.adminAddress,
      graceSecs: config.simulation.graceSecs,
      underwriter: config.simulation.underwriter ?? undefined,
    }),
  );
}

export interface AppOptions {
  /** Requests allowed per client address per minute. Defaults to RATE_LIMIT_PER_MINUTE, then 300. */
  rateLimitPerMinute?: number;
}

export function createApp(config: Config, gateway: Gateway = createGateway(config), options: AppOptions = {}) {
  const app = express();
  app.set("json replacer", jsonReplacer);
  // One proxy sits in front of the deployed service (Render). Without this,
  // req.ip is the proxy's address and every visitor would share one rate limit.
  app.set("trust proxy", 1);
  const requireAdmin = adminGuard(config, gateway);
  const rateLimit = options.rateLimitPerMinute ?? (Number(process.env.RATE_LIMIT_PER_MINUTE) || 300);

  // Middleware
  app.use(cors());
  app.use(express.json());
  // Probes are exempt so a platform health check can never be answered with a 429.
  app.use(rateLimiter(rateLimit, 60_000, { skipPaths: ["/health", "/healthz", "/readyz"] }));
  app.use(createHealthRouter(gateway));

  // Request logging middleware
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "healthy",
      service: "StellarHomes Backend",
      version: "1.0.0",
      network: config.network,
      ledger: gateway.mode,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Platform stats
  app.get(
    "/stats",
    route(async (_req, res) => {
      const [maxLtvBps, maxRateBps, secondsPerMonth, graceSecs] = await Promise.all([
        gateway.read<bigint>("mortgage", "get_max_ltv_bps"),
        gateway.read<number>("mortgage", "get_max_rate_bps"),
        gateway.read<bigint>("mortgage", "get_seconds_per_month"),
        gateway.read<bigint>("mortgage", "get_grace_secs"),
      ]);
      res.json({
        platform: "StellarHomes",
        network: config.network,
        // "simulated": an in-memory port of the contracts. "soroban": the
        // deployed contracts, with writes returned as transactions to sign.
        ledger: gateway.mode,
        contracts: {
          propertyRegistry: gateway.contracts.registry,
          lendingPool: gateway.contracts.lending,
          mortgagePool: gateway.contracts.mortgage,
        },
        admin: config.adminAddress,
        // Read from the mortgage pool, where they are fixed in code.
        rules: {
          milestones: MILESTONE_COUNT,
          maxLtvBps,
          maxRateBps,
          secondsPerMonth,
          graceSecs,
          amountUnits: "the settlement asset's smallest unit (USDC has 7 decimals)",
        },
        ledgerTime: gateway.now(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // API Routes
  app.use("/api", createKycRouter(gateway));
  app.use("/api", createChainRouter(config, gateway));
  app.use("/api/admin", createAdminRouter(config, gateway, requireAdmin));
  app.use("/api/properties", createPropertyRouter(gateway));
  app.use("/api/mortgages", createMortgageRouter(gateway));
  app.use("/api/pool", createPoolRouter(gateway));
  app.use("/api/audit", createAuditRouter(requireAdmin));

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "NotFound", message: "Endpoint not found" });
  });

  app.use(errorHandler);

  return app;
}
