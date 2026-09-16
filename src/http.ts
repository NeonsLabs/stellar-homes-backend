import { NextFunction, Request, RequestHandler, Response } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { AuthError, ContractError, HostError } from "./chain/spec";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, "InvalidRequest", message);

/** Lets route handlers be async and still reach the error handler. */
export function route(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────
//
// Amounts, ids and timestamps are integers the size of the contracts' own
// types. They are accepted as decimal strings (or as JSON numbers while they
// are exactly representable) and always returned as strings.

const U32_MAX = 2n ** 32n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const I128_MAX = 2n ** 127n - 1n;
const I128_MIN = -(2n ** 127n);

function integer(value: unknown, field: string, min: bigint, max: bigint): bigint {
  let parsed: bigint | null = null;
  if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?\d{1,40}$/.test(value.trim())) parsed = BigInt(value.trim());
  if (parsed === null) throw badRequest(`${field} must be an integer, as a string or a safe JSON number`);
  if (parsed < min || parsed > max) throw badRequest(`${field} is out of range`);
  return parsed;
}

export const parse = {
  u32: (value: unknown, field: string): number => Number(integer(value, field, 0n, U32_MAX)),
  u64: (value: unknown, field: string): bigint => integer(value, field, 0n, U64_MAX),
  /** In the settlement asset's smallest unit: 7 decimal places for USDC. */
  i128: (value: unknown, field: string): bigint => integer(value, field, I128_MIN, I128_MAX),

  /** A Stellar account (G...) or contract (C...) address. */
  address(value: unknown, field: string): string {
    if (typeof value === "string" && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
      return value;
    }
    throw badRequest(`${field} must be a Stellar address`);
  },

  /** A 32-byte digest as 64 hex characters, with or without 0x. */
  hash(value: unknown, field: string): string {
    if (typeof value === "string") {
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return hex.toLowerCase();
    }
    throw badRequest(`${field} must be a 32-byte digest in hex, e.g. a SHA-256 of the document`);
  },

  bool(value: unknown, field: string): boolean {
    if (typeof value === "boolean") return value;
    throw badRequest(`${field} must be true or false`);
  },
};

// ─── Errors ──────────────────────────────────────────────────────────

const NOT_FOUND = new Set(["UnknownProperty", "UnknownMortgage"]);
const FORBIDDEN = new Set(["NotAuthorized", "NotTrustee", "NotOracle", "NotBorrower"]);
const INVALID = new Set(["InvalidAmount", "InvalidTerm", "InvalidRate", "InvalidValuation", "InvalidStage", "InvalidGrace"]);

function statusFor(err: ContractError): number {
  if (NOT_FOUND.has(err.errorName)) return 404;
  if (FORBIDDEN.has(err.errorName)) return 403;
  if (INVALID.has(err.errorName)) return 400;
  return 409;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err instanceof ContractError) {
    return res.status(statusFor(err)).json({
      error: err.errorName,
      code: err.code,
      contract: err.contract,
      message: err.message,
    });
  }
  if (err instanceof AuthError) {
    return res.status(403).json({ error: "NotSigned", message: err.message });
  }
  if (err instanceof HostError) {
    return res.status(422).json({ error: "HostError", message: err.message });
  }
  // Malformed JSON bodies.
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "InvalidRequest", message: "Request body is not valid JSON" });
  }
  console.error("[Error]:", err);
  return res.status(500).json({ error: "InternalError", message: "Internal server error" });
}

/** bigint has no JSON form; the contracts' integers go out as strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
