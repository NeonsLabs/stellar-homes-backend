import { Router } from "express";
import { logEvent } from "../audit";
import { Gateway } from "../chain/gateway";
import { ContractName, EVENT_PREFIX } from "../chain/spec";
import { Config } from "../config";
import { badRequest, HttpError, parse, route } from "../http";
import { presentEvent } from "../present";

export function createChainRouter(config: Config, gateway: Gateway): Router {
  const router = Router();

  // Relay a transaction prepared by one of the write endpoints, once the
  // acting wallet has signed it.
  router.post(
    "/tx/submit",
    route(async (req, res) => {
      if (gateway.mode !== "soroban") {
        throw new HttpError(409, "NothingToSubmit", "The simulated ledger applies calls directly");
      }
      const { transaction } = req.body;
      if (typeof transaction !== "string" || !transaction) throw badRequest("transaction must be signed base64 XDR");

      const result = await gateway.submit(transaction);
      logEvent({
        type: "TX",
        action: `SUBMITTED_${result.status}`,
        details: `${result.contract}.${result.method} ${result.hash}`,
      });
      return res.status(result.status === "PENDING" ? 202 : 200).json(result);
    }),
  );

  // Contract events, named as in the contract repo's docs/EVENTS.md
  router.get(
    "/events",
    route(async (req, res) => {
      const { contract, name } = req.query;
      if (contract !== undefined && !(String(contract) in EVENT_PREFIX)) {
        throw badRequest(`contract must be one of: ${Object.keys(EVENT_PREFIX).join(", ")}`);
      }
      const events = await gateway.events({
        contract: contract as ContractName | undefined,
        name: name === undefined ? undefined : String(name),
        startLedger: req.query.startLedger === undefined ? undefined : parse.u32(req.query.startLedger, "startLedger"),
        limit: Math.min(1000, Math.max(1, parse.u32(req.query.limit ?? 100, "limit"))),
      });
      return res.json({ total: events.length, events: events.map(presentEvent) });
    }),
  );

  // Move the simulated ledger's clock, to watch interest accrue and loans fall
  // into arrears without waiting a month.
  router.post(
    "/dev/advance-time",
    route(async (req, res) => {
      if (!gateway.simulation || !config.simulation.allowTimeTravel) {
        throw new HttpError(404, "NotFound", "Endpoint not found");
      }
      const seconds = parse.u64(req.body.seconds, "seconds");
      gateway.simulation.advanceTime(seconds);
      return res.json({ ledgerTime: gateway.now() });
    }),
  );

  return router;
}
