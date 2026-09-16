// The slice of the stellar-homes-contract interface this backend uses.
//
// One table drives both ledgers: the simulated ledger dispatches on these
// method names, and the Soroban gateway encodes arguments in this order and
// with these types. Keep it in step with the contracts' `lib.rs`.

export type ContractName = "registry" | "lending" | "mortgage";

export type ArgType = "address" | "bool" | "u32" | "u64" | "i128" | "bytes32";

/** A decoded argument: addresses and hashes are strings, integers are bigint
 *  except u32, which is a number, exactly as `scValToNative` returns them. */
export type NativeArg = string | bigint | number | boolean;

export type Signature = readonly (readonly [name: string, type: ArgType])[];

export const WRITES = {
  registry: {
    set_trustee: [["admin", "address"], ["trustee", "address"], ["authorized", "bool"]],
    set_oracle: [["admin", "address"], ["oracle", "address"], ["authorized", "bool"]],
    submit_property: [["trustee", "address"], ["title_hash", "bytes32"], ["survey_doc_hash", "bytes32"]],
    submit_milestone_evidence: [
      ["trustee", "address"],
      ["property_id", "u64"],
      ["stage", "u32"],
      ["evidence_hash", "bytes32"],
    ],
    verify_title: [["oracle", "address"], ["property_id", "u64"]],
    set_valuation: [["oracle", "address"], ["property_id", "u64"], ["usdc_value", "i128"]],
    verify_milestone: [["oracle", "address"], ["property_id", "u64"], ["stage", "u32"]],
  },
  lending: {
    deposit: [["investor", "address"], ["amount", "i128"]],
    withdraw: [["investor", "address"], ["amount", "i128"]],
    claim_interest: [["investor", "address"]],
  },
  mortgage: {
    set_underwriter: [["admin", "address"], ["underwriter", "address"], ["authorized", "bool"]],
    apply: [
      ["borrower", "address"],
      ["property_id", "u64"],
      ["principal", "i128"],
      ["term_months", "u32"],
      ["rate_bps", "u32"],
    ],
    repay: [["mortgage_id", "u64"], ["amount", "i128"]],
    approve: [["underwriter", "address"], ["mortgage_id", "u64"]],
    decline: [["underwriter", "address"], ["mortgage_id", "u64"]],
    disburse: [["mortgage_id", "u64"], ["stage", "u32"]],
    mark_default: [["mortgage_id", "u64"]],
  },
} as const satisfies Record<ContractName, Record<string, Signature>>;

export const READS = {
  registry: {
    get_property: [["property_id", "u64"]],
    get_status_of: [["property_id", "u64"]],
    get_milestone: [["property_id", "u64"], ["stage", "u32"]],
    is_releasable: [["property_id", "u64"], ["stage", "u32"]],
    verified_stage_count: [["property_id", "u64"]],
    is_trustee: [["trustee", "address"]],
    is_oracle: [["oracle", "address"]],
    get_next_id: [],
    get_admin: [],
    get_mortgage_pool: [],
  },
  lending: {
    available: [],
    pool_state: [],
    position_of_investor: [["investor", "address"]],
    claimable_interest: [["investor", "address"]],
    get_admin: [],
    get_settlement_token: [],
  },
  mortgage: {
    get_mortgage: [["mortgage_id", "u64"]],
    current_balance: [["mortgage_id", "u64"]],
    amount_due: [["mortgage_id", "u64"]],
    payoff_amount: [["mortgage_id", "u64"]],
    tranche_amount: [["mortgage_id", "u64"], ["stage", "u32"]],
    is_defaultable: [["mortgage_id", "u64"]],
    mortgage_for_property: [["property_id", "u64"]],
    is_underwriter: [["underwriter", "address"]],
    get_admin: [],
    get_grace_secs: [],
    get_max_ltv_bps: [],
    get_max_rate_bps: [],
    get_seconds_per_month: [],
  },
} as const satisfies Record<ContractName, Record<string, Signature>>;

export type WriteMethod<C extends ContractName> = keyof (typeof WRITES)[C] & string;
export type ReadMethod<C extends ContractName> = keyof (typeof READS)[C] & string;
export type Args = Record<string, NativeArg>;

export function signatureOf(contract: ContractName, method: string): Signature | undefined {
  const writes = WRITES[contract] as Record<string, Signature>;
  const reads = READS[contract] as Record<string, Signature>;
  return writes[method] ?? reads[method];
}

/** Order named arguments as the contract function declares them. */
export function orderArgs(contract: ContractName, method: string, args: Args): NativeArg[] {
  const signature = signatureOf(contract, method);
  if (!signature) throw new Error(`${contract}.${method} is not part of the contract interface`);
  return signature.map(([name]) => {
    if (!(name in args)) throw new Error(`${contract}.${method} is missing argument ${name}`);
    return args[name];
  });
}

// ─── Events ──────────────────────────────────────────────────────────

/** The topic symbol each contract publishes under. */
export const EVENT_PREFIX: Record<ContractName, string> = {
  registry: "registry",
  lending: "pool",
  mortgage: "mortgage",
};

/** Names for the tuple each event carries, from docs/EVENTS.md. */
export const EVENT_FIELDS: Record<ContractName, Record<string, readonly string[]>> = {
  registry: {
    submitted: ["property_id", "trustee"],
    trustee: ["trustee", "authorized"],
    oracle: ["oracle", "authorized"],
    title: ["property_id", "oracle"],
    valuation: ["property_id", "oracle", "usdc_value"],
    evidence: ["property_id", "stage", "evidence_hash"],
    verified: ["property_id", "stage", "oracle"],
    released: ["property_id", "stage"],
    status: ["property_id", "status"],
  },
  lending: {
    deposit: ["investor", "amount", "total_capital"],
    withdraw: ["investor", "amount", "total_capital"],
    interest: ["investor", "amount"],
    reserve: ["amount", "total_reserved"],
    unreserve: ["amount", "total_reserved"],
    disburse: ["to", "amount", "total_lent"],
    repay: ["from", "principal", "interest"],
    writeoff: ["principal", "total_written_off"],
  },
  mortgage: {
    applied: ["id", "property_id", "borrower", "principal"],
    approved: ["id", "underwriter", "principal"],
    declined: ["id", "underwriter"],
    disbursd: ["id", "stage", "tranche", "trustee"],
    repaid: ["id", "amount", "principal", "interest"],
    default: ["id", "written_off", "undrawn"],
    undrwrtr: ["underwriter", "authorized"],
  },
};

export interface ContractEvent {
  contract: ContractName;
  name: string;
  data: Record<string, unknown>;
  /** Ledger close time, in seconds. */
  timestamp: bigint;
  /** Ledger sequence on-chain; a running counter in simulation. */
  ledger: number;
  txHash?: string;
}

export function nameEventData(contract: ContractName, name: string, values: unknown[]): Record<string, unknown> {
  const fields = EVENT_FIELDS[contract][name];
  if (!fields) return { values };
  return Object.fromEntries(fields.map((field, i) => [field, values[i]]));
}

// ─── Errors ──────────────────────────────────────────────────────────

/** Each contract's `#[contracterror]` enum, by code. */
export const ERROR_NAMES: Record<ContractName, Record<number, string>> = {
  registry: {
    2: "NotInitialized",
    3: "NotAuthorized",
    4: "AlreadySet",
    5: "NoPendingAction",
    6: "ActionPending",
    7: "TimelockNotExpired",
    8: "UnknownProperty",
    9: "NotTrustee",
    10: "NotOracle",
    11: "WrongStatus",
    12: "InvalidValuation",
    13: "InvalidStage",
    14: "NoEvidence",
    15: "AlreadyVerified",
    16: "OutOfOrder",
    17: "MortgagePoolNotSet",
  },
  lending: {
    2: "NotInitialized",
    3: "NotAuthorized",
    4: "AlreadySet",
    5: "NoPendingAction",
    6: "ActionPending",
    7: "TimelockNotExpired",
    8: "InvalidAmount",
    9: "InsufficientShares",
    10: "InsufficientAvailable",
    11: "InsufficientReserved",
    12: "MortgagePoolNotSet",
    13: "NothingDeposited",
    14: "NothingToClaim",
  },
  mortgage: {
    2: "NotInitialized",
    3: "NotAuthorized",
    5: "NoPendingAction",
    6: "ActionPending",
    7: "TimelockNotExpired",
    8: "UnknownMortgage",
    9: "WrongStatus",
    10: "InvalidAmount",
    11: "InvalidTerm",
    12: "InvalidRate",
    13: "PropertyNotVerified",
    14: "ExceedsLtv",
    15: "NotBorrower",
    16: "StageNotReleasable",
    17: "NothingToDisburse",
    18: "Underpaid",
    19: "NotInArrears",
    20: "PropertyHasMortgage",
    21: "InvalidGrace",
  },
};

/** A `panic_with_error!` from one of the contracts. */
export class ContractError extends Error {
  readonly contract: ContractName;
  readonly code: number;
  readonly errorName: string;

  constructor(contract: ContractName, code: number) {
    const errorName = ERROR_NAMES[contract][code] ?? `Error${code}`;
    super(`${contract}: ${errorName} (#${code})`);
    this.contract = contract;
    this.code = code;
    this.errorName = errorName;
  }
}

/** A `require_auth` that the transaction does not satisfy. */
export class AuthError extends Error {
  readonly address: string;

  constructor(address: string) {
    super(`transaction is not authorized by ${address}`);
    this.address = address;
  }
}

/** A host-level failure that is not a contract error: an overflow, a failed
 *  token transfer, archived state. */
export class HostError extends Error {}
