// MortgagePool, ported from stellar-homes-contract
// `contracts/mortgage_pool/src/lib.rs`.
//
// Method names, argument order, check order and error codes follow the Rust so
// the two can be read side by side. Timelocked upgrades, grace-period changes
// and admin handover are left out.
//
// The interest helpers at the bottom are exported: they are the chain's
// arithmetic, and the repayment-schedule projection reuses them rather than
// keeping a second copy that could drift.

import { ContractError } from "../spec";
import { Env, i128 } from "./env";
import { LendingPool } from "./lending";
import { PropertyRegistry } from "./registry";

export const BPS_DENOMINATOR = 10_000n;
export const MONTHS_PER_YEAR = 12n;
/** A billing month, fixed at 30 days. */
export const SECONDS_PER_MONTH = 30n * 24n * 60n * 60n;
export const MILESTONE_COUNT = 5;
/** 80% loan-to-value, fixed in code. */
export const MAX_LTV_BPS = 8_000n;
/** 30% annual rate cap, fixed in code. */
export const MAX_RATE_BPS = 3_000;

const E = {
  NotAuthorized: 3,
  UnknownMortgage: 8,
  WrongStatus: 9,
  InvalidAmount: 10,
  InvalidTerm: 11,
  InvalidRate: 12,
  PropertyNotVerified: 13,
  ExceedsLtv: 14,
  StageNotReleasable: 16,
  NothingToDisburse: 17,
  Underpaid: 18,
  NotInArrears: 19,
  PropertyHasMortgage: 20,
} as const;

function panic(code: number): never {
  throw new ContractError("mortgage", code);
}

export type MortgageStatus = "Applied" | "Approved" | "Funded" | "Repaying" | "PaidOff" | "Defaulted";

export interface Mortgage {
  id: bigint;
  property_id: bigint;
  borrower: string;
  principal: bigint;
  term_months: number;
  rate_bps: number;
  status: MortgageStatus;
  disbursed: bigint;
  outstanding: bigint;
  interest_accrued: bigint;
  interest_carry: bigint;
  total_repaid: bigint;
  interest_paid: bigint;
  payments_made: number;
  last_accrued_at: bigint;
  next_payment_due: bigint;
  created_at: bigint;
}

export interface MortgageState {
  admin: string;
  graceSecs: bigint;
  nextId: bigint;
  underwriters: Set<string>;
  mortgages: Map<bigint, Mortgage>;
  propertyMortgage: Map<bigint, bigint>;
}

export class MortgagePool {
  readonly address: string;
  private readonly registry: PropertyRegistry;
  private readonly pool: LendingPool;
  state: MortgageState;

  constructor(
    address: string,
    admin: string,
    registry: PropertyRegistry,
    lendingPool: LendingPool,
    graceSecs: bigint,
  ) {
    this.address = address;
    this.registry = registry;
    this.pool = lendingPool;
    this.state = {
      admin,
      graceSecs,
      nextId: 1n,
      underwriters: new Set(),
      mortgages: new Map(),
      propertyMortgage: new Map(),
    };
  }

  // --- Administration ---

  set_underwriter(env: Env, admin: string, underwriter: string, authorized: boolean): void {
    this.requireAdmin(env, admin);
    if (authorized) this.state.underwriters.add(underwriter);
    else this.state.underwriters.delete(underwriter);
    env.publish("mortgage", "undrwrtr", [underwriter, authorized]);
  }

  // --- Borrower operations ---

  apply(
    env: Env,
    borrower: string,
    property_id: bigint,
    principal: bigint,
    term_months: number,
    rate_bps: number,
  ): bigint {
    env.requireAuth(borrower);
    if (principal <= 0n) panic(E.InvalidAmount);
    if (term_months === 0) panic(E.InvalidTerm);
    if (rate_bps > MAX_RATE_BPS) panic(E.InvalidRate);
    if (this.state.propertyMortgage.has(property_id)) panic(E.PropertyHasMortgage);

    const [, valuation, verified] = this.registry.lending_terms(this.as(env), property_id);
    if (!verified) panic(E.PropertyNotVerified);
    if (exceedsLtv(principal, valuation)) panic(E.ExceedsLtv);

    const id = this.state.nextId;
    this.state.nextId = id + 1n;

    this.save({
      id,
      property_id,
      borrower,
      principal,
      term_months,
      rate_bps,
      status: "Applied",
      disbursed: 0n,
      outstanding: 0n,
      interest_accrued: 0n,
      interest_carry: 0n,
      total_repaid: 0n,
      interest_paid: 0n,
      payments_made: 0,
      last_accrued_at: 0n,
      next_payment_due: 0n,
      created_at: env.timestamp(),
    });
    this.state.propertyMortgage.set(property_id, id);

    env.publish("mortgage", "applied", [id, property_id, borrower, principal]);
    return id;
  }

  repay(env: Env, mortgage_id: bigint, amount: bigint): void {
    if (amount <= 0n) panic(E.InvalidAmount);
    const mortgage = this.mortgageOf(mortgage_id);
    env.requireAuth(mortgage.borrower);
    if (mortgage.status !== "Funded" && mortgage.status !== "Repaying") panic(E.WrongStatus);

    accrue(mortgage, env.timestamp());

    const payoff = payoffOf(mortgage);
    const due = instalmentDue(mortgage);
    if (amount < due && amount < payoff) panic(E.Underpaid);
    const { interestPart, principalPart } = applyPayment(mortgage, amount < payoff ? amount : payoff);

    const as = this.as(env);
    this.pool.repay(as, this.address, mortgage.borrower, principalPart, interestPart);

    if (mortgage.outstanding === 0n && mortgage.interest_accrued === 0n) {
      const undrawn = mortgage.principal - mortgage.disbursed;
      if (undrawn > 0n) this.pool.unreserve(as, this.address, undrawn);
      mortgage.status = "PaidOff";
      this.state.propertyMortgage.delete(mortgage.property_id);
      this.registry.mark_repaid(as, this.address, mortgage.property_id);
    }

    this.save(mortgage);
    env.publish("mortgage", "repaid", [mortgage_id, interestPart + principalPart, principalPart, interestPart]);
  }

  // --- Underwriter operations ---

  approve(env: Env, underwriter: string, mortgage_id: bigint): void {
    this.requireUnderwriter(env, underwriter);
    const mortgage = this.mortgageOf(mortgage_id);
    if (mortgage.status !== "Applied") panic(E.WrongStatus);
    const [, valuation, verified] = this.registry.lending_terms(this.as(env), mortgage.property_id);
    if (!verified) panic(E.PropertyNotVerified);
    if (exceedsLtv(mortgage.principal, valuation)) panic(E.ExceedsLtv);

    this.pool.reserve(this.as(env), this.address, mortgage.principal);

    mortgage.status = "Approved";
    this.save(mortgage);

    env.publish("mortgage", "approved", [mortgage_id, underwriter, mortgage.principal]);
  }

  decline(env: Env, underwriter: string, mortgage_id: bigint): void {
    this.requireUnderwriter(env, underwriter);
    const mortgage = this.mortgageOf(mortgage_id);
    if (mortgage.status !== "Applied") panic(E.WrongStatus);
    this.state.propertyMortgage.delete(mortgage.property_id);
    this.state.mortgages.delete(mortgage_id);

    env.publish("mortgage", "declined", [mortgage_id, underwriter]);
  }

  // --- Milestone-gated disbursement ---

  disburse(env: Env, mortgage_id: bigint, stage: number): bigint {
    const mortgage = this.mortgageOf(mortgage_id);
    if (mortgage.status !== "Approved" && mortgage.status !== "Funded") panic(E.WrongStatus);

    const as = this.as(env);
    if (!this.registry.is_releasable(as, mortgage.property_id, stage)) panic(E.StageNotReleasable);

    const tranche = trancheFor(mortgage, stage);
    if (tranche <= 0n) panic(E.NothingToDisburse);

    accrue(mortgage, env.timestamp());

    const [trustee] = this.registry.lending_terms(as, mortgage.property_id);

    this.registry.mark_released(as, this.address, mortgage.property_id, stage);
    this.pool.disburse(as, this.address, trustee, tranche);

    const firstDraw = mortgage.disbursed === 0n;
    mortgage.disbursed = i128(mortgage.disbursed + tranche);
    mortgage.outstanding = i128(mortgage.outstanding + tranche);

    if (firstDraw) {
      const now = env.timestamp();
      mortgage.status = "Funded";
      mortgage.last_accrued_at = now;
      mortgage.next_payment_due = now + SECONDS_PER_MONTH;
      this.registry.mark_mortgaged(as, this.address, mortgage.property_id);
    }

    this.save(mortgage);
    env.publish("mortgage", "disbursd", [mortgage_id, stage, tranche, trustee]);
    return tranche;
  }

  // --- Default ---

  mark_default(env: Env, mortgage_id: bigint): void {
    const mortgage = this.mortgageOf(mortgage_id);
    if (mortgage.status !== "Funded" && mortgage.status !== "Repaying") panic(E.WrongStatus);
    if (!isInDefault(mortgage, env.timestamp(), this.state.graceSecs)) panic(E.NotInArrears);

    accrue(mortgage, env.timestamp());
    const as = this.as(env);

    const undrawn = mortgage.principal - mortgage.disbursed;
    if (undrawn > 0n) this.pool.unreserve(as, this.address, undrawn);
    if (mortgage.outstanding > 0n) this.pool.write_off(as, this.address, mortgage.outstanding);

    mortgage.status = "Defaulted";
    this.state.propertyMortgage.delete(mortgage.property_id);
    this.registry.mark_defaulted(as, this.address, mortgage.property_id);
    this.save(mortgage);

    env.publish("mortgage", "default", [mortgage_id, mortgage.outstanding, undrawn]);
  }

  // --- Getters ---

  get_mortgage(_env: Env, mortgage_id: bigint): Mortgage {
    return this.mortgageOf(mortgage_id);
  }

  current_balance(env: Env, mortgage_id: bigint): [bigint, bigint] {
    const mortgage = this.mortgageOf(mortgage_id);
    accrue(mortgage, env.timestamp());
    return [mortgage.outstanding, mortgage.interest_accrued];
  }

  amount_due(env: Env, mortgage_id: bigint): bigint {
    const mortgage = this.mortgageOf(mortgage_id);
    accrue(mortgage, env.timestamp());
    const due = instalmentDue(mortgage);
    const payoff = payoffOf(mortgage);
    return due > payoff ? payoff : due;
  }

  payoff_amount(env: Env, mortgage_id: bigint): bigint {
    const mortgage = this.mortgageOf(mortgage_id);
    accrue(mortgage, env.timestamp());
    return payoffOf(mortgage);
  }

  tranche_amount(_env: Env, mortgage_id: bigint, stage: number): bigint {
    return trancheFor(this.mortgageOf(mortgage_id), stage);
  }

  is_defaultable(env: Env, mortgage_id: bigint): boolean {
    const mortgage = this.mortgageOf(mortgage_id);
    return (
      (mortgage.status === "Funded" || mortgage.status === "Repaying") &&
      isInDefault(mortgage, env.timestamp(), this.state.graceSecs)
    );
  }

  mortgage_for_property(_env: Env, property_id: bigint): bigint | null {
    return this.state.propertyMortgage.get(property_id) ?? null;
  }

  is_underwriter(_env: Env, underwriter: string): boolean {
    return this.state.underwriters.has(underwriter);
  }

  get_admin(_env: Env): string {
    return this.state.admin;
  }

  get_grace_secs(_env: Env): bigint {
    return this.state.graceSecs;
  }

  get_max_ltv_bps(_env: Env): bigint {
    return MAX_LTV_BPS;
  }

  get_max_rate_bps(_env: Env): number {
    return MAX_RATE_BPS;
  }

  get_seconds_per_month(_env: Env): bigint {
    return SECONDS_PER_MONTH;
  }

  // --- Internals ---

  /** The environment this contract hands to the contracts it calls. */
  private as(env: Env): Env {
    return env.calledBy(this.address);
  }

  private mortgageOf(mortgageId: bigint): Mortgage {
    const mortgage = this.state.mortgages.get(mortgageId);
    if (!mortgage) panic(E.UnknownMortgage);
    return { ...mortgage };
  }

  private save(mortgage: Mortgage): void {
    this.state.mortgages.set(mortgage.id, { ...mortgage });
  }

  private requireAdmin(env: Env, admin: string): void {
    env.requireAuth(admin);
    if (admin !== this.state.admin) panic(E.NotAuthorized);
  }

  private requireUnderwriter(env: Env, underwriter: string): void {
    env.requireAuth(underwriter);
    if (!this.state.underwriters.has(underwriter)) panic(E.NotAuthorized);
  }
}

// ─── The chain's arithmetic ──────────────────────────────────────────

function exceedsLtv(principal: bigint, valuation: bigint): boolean {
  return i128(principal * BPS_DENOMINATOR) > i128(valuation * MAX_LTV_BPS);
}

/** Charge interest for every whole month since the last accrual, carrying the
 *  division's remainder so accrual frequency never changes the total. */
export function accrue(mortgage: Mortgage, now: bigint): void {
  if (mortgage.last_accrued_at === 0n || mortgage.outstanding <= 0n) return;
  if (now <= mortgage.last_accrued_at) return;
  const months = (now - mortgage.last_accrued_at) / SECONDS_PER_MONTH;
  if (months === 0n) return;
  const divisor = BPS_DENOMINATOR * MONTHS_PER_YEAR;
  const numerator = i128(mortgage.outstanding * BigInt(mortgage.rate_bps) * months + mortgage.interest_carry);
  mortgage.interest_accrued = i128(mortgage.interest_accrued + numerator / divisor);
  mortgage.interest_carry = numerator % divisor;
  mortgage.last_accrued_at += months * SECONDS_PER_MONTH;
}

/** Interest owed plus a fixed slice of the whole facility. */
export function instalmentDue(mortgage: Mortgage): bigint {
  const slice = mortgage.principal / BigInt(mortgage.term_months);
  const principalPart = slice > mortgage.outstanding ? mortgage.outstanding : slice;
  return mortgage.interest_accrued + principalPart;
}

export function payoffOf(mortgage: Mortgage): bigint {
  return mortgage.outstanding + mortgage.interest_accrued;
}

/** Apply an accepted payment, already capped at the payoff: interest first,
 *  then principal. Mirrors the bookkeeping in `repay`. */
export function applyPayment(mortgage: Mortgage, amount: bigint): { interestPart: bigint; principalPart: bigint } {
  const interestPart = amount >= mortgage.interest_accrued ? mortgage.interest_accrued : amount;
  const principalPart = amount - interestPart;

  mortgage.interest_accrued -= interestPart;
  mortgage.outstanding -= principalPart;
  mortgage.total_repaid = i128(mortgage.total_repaid + amount);
  mortgage.interest_paid = i128(mortgage.interest_paid + interestPart);
  mortgage.payments_made += 1;
  mortgage.next_payment_due += SECONDS_PER_MONTH;
  mortgage.status = "Repaying";
  return { interestPart, principalPart };
}

/** An equal share of the facility; the last stage takes the remainder. */
export function trancheFor(mortgage: Mortgage, stage: number): bigint {
  const count = BigInt(MILESTONE_COUNT);
  const each = mortgage.principal / count;
  return stage === MILESTONE_COUNT - 1 ? mortgage.principal - each * (count - 1n) : each;
}

export function isInDefault(mortgage: Mortgage, now: bigint, graceSecs: bigint): boolean {
  if (mortgage.next_payment_due === 0n) return false;
  return now > mortgage.next_payment_due + graceSecs;
}
