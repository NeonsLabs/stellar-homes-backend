import { createHash, timingSafeEqual } from "crypto";
import { RequestHandler, Response } from "express";
import { CreateEventInput, logEvent } from "../audit";
import { Gateway, WriteOutcome } from "../chain/gateway";
import { presentEvent } from "../present";
import { Config } from "../config";
import { HttpError } from "../http";

/** Answer a state-changing request.
 *
 *  Against the simulated ledger the call has already happened: the response
 *  carries its result, the events it published, and whatever `view` adds.
 *  Against deployed contracts nothing has happened yet: the response carries
 *  the unsigned transaction for `source` to sign and submit. */
export async function sendWrite(
  res: Response,
  outcome: WriteOutcome,
  audit: CreateEventInput | ((result: unknown) => CreateEventInput),
  options: { view?: (result: unknown) => Promise<object> | object; created?: boolean } = {},
) {
  if (outcome.mode === "soroban") {
    const entry = typeof audit === "function" ? audit(undefined) : audit;
    logEvent({ ...entry, type: "TX", action: `PREPARED_${entry.action}` });
    return res.json(outcome);
  }
  logEvent(typeof audit === "function" ? audit(outcome.result) : audit);
  const view = options.view ? await options.view(outcome.result) : {};
  return res.status(options.created ? 201 : 200).json({
    mode: outcome.mode,
    result: outcome.result ?? null,
    events: outcome.events.map(presentEvent),
    ...view,
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Guards the contracts' admin calls.
 *
 *  On-chain, the admin's own signature is the guard: the backend only prepares
 *  the transaction. The simulated ledger verifies no signatures, so there the
 *  admin API key stands in for one. */
export function adminGuard(config: Config, gateway: Gateway): RequestHandler {
  return (req, _res, next) => {
    if (gateway.mode === "soroban") return next();
    if (!config.adminApiKey) {
      return next(new HttpError(503, "AdminDisabled", "Set ADMIN_API_KEY to enable admin calls"));
    }
    const presented = req.header("x-admin-key") ?? "";
    if (!timingSafeEqual(digest(presented), digest(config.adminApiKey))) {
      return next(new HttpError(401, "AdminKeyRequired", "A valid x-admin-key header is required"));
    }
    return next();
  };
}
