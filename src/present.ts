// Contract records as the API returns them: camelCase, integers as strings
// (via the JSON replacer), and nothing renamed beyond the casing, so a field
// can always be traced back to the struct it came from.

import { ContractEvent } from "./chain/spec";
import { PoolState, Position } from "./chain/sim/lending";
import { accrue, applyPayment, instalmentDue, Mortgage, payoffOf } from "./chain/sim/mortgage";
import { Milestone, Property, ZERO_HASH } from "./chain/sim/registry";

export const STAGE_NAMES = ["Foundation", "Walls", "Roofing", "Finishing", "Handover"] as const;

export function presentMilestone(m: Milestone) {
  return {
    stage: m.stage,
    name: STAGE_NAMES[m.stage],
    // The registry writes an all-zero digest until evidence is submitted.
    evidenceHash: m.evidence_hash === ZERO_HASH ? null : m.evidence_hash,
    verified: m.verified,
    released: m.released,
    verifiedBy: m.verified_by,
  };
}

export function presentProperty(p: Property) {
  return {
    id: p.id,
    trustee: p.trustee,
    titleHash: p.title_hash,
    surveyDocHash: p.survey_doc_hash,
    usdcValue: p.usdc_value,
    status: p.status,
    verifiedBy: p.verified_by,
    valuedBy: p.valued_by,
  };
}

export interface LiveFigures {
  outstanding: bigint;
  interestAccrued: bigint;
  amountDue: bigint;
  payoffAmount: bigint;
  isDefaultable: boolean;
}

export function presentMortgage(m: Mortgage) {
  return {
    id: m.id,
    propertyId: m.property_id,
    borrower: m.borrower,
    principal: m.principal,
    termMonths: m.term_months,
    rateBps: m.rate_bps,
    status: m.status,
    disbursed: m.disbursed,
    outstanding: m.outstanding,
    interestAccrued: m.interest_accrued,
    interestCarry: m.interest_carry,
    totalRepaid: m.total_repaid,
    interestPaid: m.interest_paid,
    paymentsMade: m.payments_made,
    lastAccruedAt: m.last_accrued_at,
    nextPaymentDue: m.next_payment_due,
    createdAt: m.created_at,
  };
}

export function presentPosition(p: Position) {
  return { shares: p.shares, rewardDebt: p.reward_debt, credited: p.credited };
}

export function presentPoolState(s: PoolState) {
  return {
    totalCapital: s.total_capital,
    totalReserved: s.total_reserved,
    totalLent: s.total_lent,
    totalInterest: s.total_interest,
    totalWrittenOff: s.total_written_off,
    totalShares: s.total_shares,
  };
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function presentEvent(e: ContractEvent) {
  return {
    contract: e.contract,
    name: e.name,
    data: Object.fromEntries(Object.entries(e.data).map(([k, v]) => [camel(k), v])),
    timestamp: e.timestamp,
    ledger: e.ledger,
    txHash: e.txHash ?? null,
  };
}

// ─── Repayment schedule ──────────────────────────────────────────────

export interface ScheduleRow {
  number: number;
  dueAt: bigint;
  payment: bigint;
  interest: bigint;
  principal: bigint;
  balanceAfter: bigint;
}

/** The instalments still to come if every one is paid exactly on its due date
 *  and nothing more is drawn, computed with the contract's own arithmetic.
 *
 *  A projection, not a promise: a further tranche, an early or late payment,
 *  or an overpayment all change it. The chain remains the source of truth. */
export function projectSchedule(mortgage: Mortgage): { rows: ScheduleRow[]; clearsInFull: boolean } {
  if (mortgage.status !== "Funded" && mortgage.status !== "Repaying") return { rows: [], clearsInFull: false };

  const loan = { ...mortgage };
  const rows: ScheduleRow[] = [];
  // A facility smaller than its term in base units amortises nothing per
  // month, so the loop is bounded rather than trusted to terminate.
  const maxRows = loan.term_months + 12;
  while (payoffOf(loan) > 0n && rows.length < maxRows) {
    const dueAt = loan.next_payment_due;
    accrue(loan, dueAt);
    const due = instalmentDue(loan);
    const payoff = payoffOf(loan);
    const payment = due < payoff ? due : payoff;
    if (payment <= 0n) break;
    const { interestPart, principalPart } = applyPayment(loan, payment);
    rows.push({
      number: loan.payments_made,
      dueAt,
      payment,
      interest: interestPart,
      principal: principalPart,
      balanceAfter: loan.outstanding,
    });
  }
  return { rows, clearsInFull: payoffOf(loan) === 0n };
}
