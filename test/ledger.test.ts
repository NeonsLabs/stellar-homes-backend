// The simulated ledger against the contracts' own test suites. Where a case
// here has a counterpart in stellar-homes-contract, it asserts the same
// figures, so a drift between the port and the Rust shows up as a failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { Args, AuthError, ContractError, ContractName } from "../src/chain/spec";
import { Env, Host } from "../src/chain/sim/env";
import { LendingPool } from "../src/chain/sim/lending";
import { SimulatedLedger } from "../src/chain/sim/ledger";
import { accrue, Mortgage, SECONDS_PER_MONTH } from "../src/chain/sim/mortgage";
import { SimToken } from "../src/chain/sim/token";

const START = 1_000_000n;
const MONTH = SECONDS_PER_MONTH;
const GRACE = 1_209_600n;
const VALUATION = 100_000n;
const PRINCIPAL = 50_000n;
const TERM = 120;
const RATE_BPS = 850;

const address = () => Keypair.random().publicKey();
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

function setup() {
  const clock = { now: START };
  const [admin, underwriter, trustee, oracle, borrower, investor] = Array.from({ length: 6 }, address);
  const ledger = new SimulatedLedger({ admin, underwriter, graceSecs: GRACE, clock: () => clock.now });

  const call = (contract: ContractName, method: string, args: Args, signer: string) =>
    ledger.invoke(contract, method, args, signer).result;
  const read = <T>(contract: ContractName, method: string, args: Args = {}) =>
    ledger.read(contract, method, args) as T;

  call("registry", "set_trustee", { admin, trustee, authorized: true }, admin);
  call("registry", "set_oracle", { admin, oracle, authorized: true }, admin);
  call("lending", "deposit", { investor, amount: 500_000n }, investor);

  const property = call(
    "registry",
    "submit_property",
    { trustee, title_hash: hash(1), survey_doc_hash: hash(2) },
    trustee,
  ) as bigint;
  call("registry", "verify_title", { oracle, property_id: property }, oracle);
  call("registry", "set_valuation", { oracle, property_id: property, usdc_value: VALUATION }, oracle);

  const s = {
    ledger,
    clock,
    admin,
    underwriter,
    trustee,
    oracle,
    borrower,
    investor,
    property,
    call,
    read,
    mortgage: (id: bigint) => read<Mortgage>("mortgage", "get_mortgage", { mortgage_id: id }),
    pool: () => read<Record<string, bigint>>("lending", "pool_state"),
    signOff(stage: number) {
      call(
        "registry",
        "submit_milestone_evidence",
        { trustee, property_id: property, stage, evidence_hash: hash(10 + stage) },
        trustee,
      );
      call("registry", "verify_milestone", { oracle, property_id: property, stage }, oracle);
    },
    apply(principal = PRINCIPAL, rate_bps = RATE_BPS, term_months = TERM) {
      return call(
        "mortgage",
        "apply",
        { borrower, property_id: property, principal, term_months, rate_bps },
        borrower,
      ) as bigint;
    },
    approved() {
      const id = s.apply();
      call("mortgage", "approve", { underwriter, mortgage_id: id }, underwriter);
      return id;
    },
    funded() {
      const id = s.approved();
      s.signOff(0);
      call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address());
      return id;
    },
    repay(id: bigint, amount: bigint) {
      call("mortgage", "repay", { mortgage_id: id, amount }, borrower);
    },
    due: (id: bigint) => read<bigint>("mortgage", "amount_due", { mortgage_id: id }),
    payoff: (id: bigint) => read<bigint>("mortgage", "payoff_amount", { mortgage_id: id }),
    balance: (id: bigint) => read<[bigint, bigint]>("mortgage", "current_balance", { mortgage_id: id }),
  };
  return s;
}

function rejects(fn: () => unknown, contract: ContractName, errorName: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ContractError, `expected a contract error, got ${err}`);
    assert.equal(`${err.contract}.${err.errorName}`, `${contract}.${errorName}`);
    return true;
  });
}

// ─── Registry ────────────────────────────────────────────────────────

test("a property is created with its five-stage build schedule", () => {
  const s = setup();
  const property = s.read<Record<string, unknown>>("registry", "get_property", { property_id: s.property });
  assert.equal(property.status, "Verified");
  assert.equal(property.verified_by, s.oracle);
  assert.equal(property.valued_by, s.oracle);
  for (let stage = 0; stage < 5; stage++) {
    const m = s.read<Record<string, unknown>>("registry", "get_milestone", { property_id: s.property, stage });
    assert.equal(m.verified, false);
    assert.equal(m.evidence_hash, "0".repeat(64));
  }
  rejects(() => s.read("registry", "get_milestone", { property_id: s.property, stage: 5 }), "registry", "InvalidStage");
  rejects(() => s.read("registry", "get_property", { property_id: 99n }), "registry", "UnknownProperty");
});

test("only registered trustees submit, and never verify their own property", () => {
  const s = setup();
  const stranger = address();
  rejects(
    () => s.call("registry", "submit_property", { trustee: stranger, title_hash: hash(3), survey_doc_hash: hash(4) }, stranger),
    "registry",
    "NotTrustee",
  );

  // Even holding both roles.
  s.call("registry", "set_oracle", { admin: s.admin, oracle: s.trustee, authorized: true }, s.admin);
  const id = s.call(
    "registry",
    "submit_property",
    { trustee: s.trustee, title_hash: hash(3), survey_doc_hash: hash(4) },
    s.trustee,
  ) as bigint;
  rejects(() => s.call("registry", "verify_title", { oracle: s.trustee, property_id: id }, s.trustee), "registry", "NotAuthorized");
  // A valuation needs a verified title first.
  rejects(
    () => s.call("registry", "set_valuation", { oracle: s.oracle, property_id: id, usdc_value: 1n }, s.oracle),
    "registry",
    "WrongStatus",
  );
  rejects(
    () => s.call("registry", "set_valuation", { oracle: s.oracle, property_id: id, usdc_value: 0n }, s.oracle),
    "registry",
    "InvalidValuation",
  );
});

test("stages are signed off in order, with evidence, once", () => {
  const s = setup();
  const p = s.property;
  rejects(() => s.call("registry", "verify_milestone", { oracle: s.oracle, property_id: p, stage: 0 }, s.oracle), "registry", "NoEvidence");

  s.call("registry", "submit_milestone_evidence", { trustee: s.trustee, property_id: p, stage: 2, evidence_hash: hash(12) }, s.trustee);
  rejects(() => s.call("registry", "verify_milestone", { oracle: s.oracle, property_id: p, stage: 2 }, s.oracle), "registry", "OutOfOrder");

  s.signOff(0);
  s.signOff(1);
  s.call("registry", "verify_milestone", { oracle: s.oracle, property_id: p, stage: 2 }, s.oracle);
  assert.equal(s.read("registry", "verified_stage_count", { property_id: p }), 3);

  rejects(() => s.call("registry", "verify_milestone", { oracle: s.oracle, property_id: p, stage: 0 }, s.oracle), "registry", "AlreadyVerified");
  rejects(
    () => s.call("registry", "submit_milestone_evidence", { trustee: s.trustee, property_id: p, stage: 0, evidence_hash: hash(9) }, s.trustee),
    "registry",
    "AlreadyVerified",
  );
});

test("a call must be signed by the address it acts for", () => {
  const s = setup();
  assert.throws(
    () => s.call("registry", "set_trustee", { admin: s.admin, trustee: address(), authorized: true }, s.oracle),
    AuthError,
  );
});

// ─── Applications and approval ───────────────────────────────────────

test("an application records the terms without committing anything", () => {
  const s = setup();
  const id = s.apply();
  const m = s.mortgage(id);
  assert.equal(m.status, "Applied");
  assert.equal(m.principal, PRINCIPAL);
  assert.equal(m.created_at, START);
  assert.equal(s.read("lending", "available"), 500_000n);
  assert.equal(s.read("mortgage", "mortgage_for_property", { property_id: s.property }), id);
});

test("lending is capped at 80% of the valuation", () => {
  const s = setup();
  const ceiling = (VALUATION * 8_000n) / 10_000n;
  rejects(() => s.apply(ceiling + 1n), "mortgage", "ExceedsLtv");
  assert.equal(s.mortgage(s.apply(ceiling)).principal, ceiling);
});

test("applications are refused on bad terms or an unverified property", () => {
  const s = setup();
  rejects(() => s.apply(0n), "mortgage", "InvalidAmount");
  rejects(() => s.apply(PRINCIPAL, RATE_BPS, 0), "mortgage", "InvalidTerm");
  rejects(() => s.apply(PRINCIPAL, 3_001), "mortgage", "InvalidRate");

  const draft = s.call(
    "registry",
    "submit_property",
    { trustee: s.trustee, title_hash: hash(3), survey_doc_hash: hash(4) },
    s.trustee,
  ) as bigint;
  rejects(
    () =>
      s.call(
        "mortgage",
        "apply",
        { borrower: s.borrower, property_id: draft, principal: 1_000n, term_months: TERM, rate_bps: RATE_BPS },
        s.borrower,
      ),
    "mortgage",
    "PropertyNotVerified",
  );
  // A missing property fails inside the registry, with the registry's code.
  rejects(
    () =>
      s.call(
        "mortgage",
        "apply",
        { borrower: s.borrower, property_id: 99n, principal: 1_000n, term_months: TERM, rate_bps: RATE_BPS },
        s.borrower,
      ),
    "registry",
    "UnknownProperty",
  );
});

test("one property backs one mortgage, and a decline frees it", () => {
  const s = setup();
  const id = s.apply();
  rejects(() => s.apply(1_000n), "mortgage", "PropertyHasMortgage");

  s.call("mortgage", "decline", { underwriter: s.underwriter, mortgage_id: id }, s.underwriter);
  assert.equal(s.read("mortgage", "mortgage_for_property", { property_id: s.property }), null);
  rejects(() => s.mortgage(id), "mortgage", "UnknownMortgage");
  s.apply();
});

test("approval commits the whole facility and is underwriter-only, once", () => {
  const s = setup();
  const id = s.apply();
  rejects(() => s.call("mortgage", "approve", { underwriter: s.admin, mortgage_id: id }, s.admin), "mortgage", "NotAuthorized");

  s.call("mortgage", "approve", { underwriter: s.underwriter, mortgage_id: id }, s.underwriter);
  assert.equal(s.mortgage(id).status, "Approved");
  assert.equal(s.read("lending", "available"), 500_000n - PRINCIPAL);
  rejects(() => s.call("lending", "withdraw", { investor: s.investor, amount: 500_000n }, s.investor), "lending", "InsufficientAvailable");
  s.call("lending", "withdraw", { investor: s.investor, amount: 450_000n }, s.investor);

  rejects(() => s.call("mortgage", "approve", { underwriter: s.underwriter, mortgage_id: id }, s.underwriter), "mortgage", "WrongStatus");
  rejects(() => s.call("mortgage", "decline", { underwriter: s.underwriter, mortgage_id: id }, s.underwriter), "mortgage", "WrongStatus");
});

// ─── Disbursement ────────────────────────────────────────────────────

test("money follows the building, and goes to the trustee", () => {
  const s = setup();
  const id = s.approved();
  rejects(() => s.call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address()), "mortgage", "StageNotReleasable");

  s.signOff(0);
  assert.equal(s.call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address()), 10_000n);
  assert.equal(s.ledger.token.balance(s.trustee), 10_000n);
  assert.equal(s.ledger.token.balance(s.borrower), 0n);

  const m = s.mortgage(id);
  assert.equal(m.status, "Funded");
  assert.equal(m.outstanding, 10_000n);
  assert.equal(m.next_payment_due, START + MONTH);
  assert.equal(s.read("registry", "get_status_of", { property_id: s.property }), "Mortgaged");

  rejects(() => s.call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address()), "mortgage", "StageNotReleasable");
  rejects(() => s.call("mortgage", "disburse", { mortgage_id: id, stage: 1 }, address()), "mortgage", "StageNotReleasable");
});

test("the whole facility is drawable across the stages", () => {
  const s = setup();
  const id = s.apply(50_003n);
  s.call("mortgage", "approve", { underwriter: s.underwriter, mortgage_id: id }, s.underwriter);
  let drawn = 0n;
  for (let stage = 0; stage < 5; stage++) {
    s.signOff(stage);
    drawn += s.call("mortgage", "disburse", { mortgage_id: id, stage }, address()) as bigint;
  }
  // The last stage takes the rounding remainder.
  assert.equal(s.read("mortgage", "tranche_amount", { mortgage_id: id, stage: 4 }), 10_003n);
  assert.equal(drawn, 50_003n);
  assert.equal(s.pool().total_lent, 50_003n);
  assert.equal(s.pool().total_reserved, 0n);
});

test("as on-chain, no tranche can be drawn once repayment has begun", () => {
  // disburse accepts only Approved or Funded, and the first repayment moves
  // the loan to Repaying. This pins the contract's current behaviour.
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;
  s.repay(id, s.due(id));
  s.signOff(1);
  rejects(() => s.call("mortgage", "disburse", { mortgage_id: id, stage: 1 }, address()), "mortgage", "WrongStatus");
});

// ─── Interest ────────────────────────────────────────────────────────

test("interest accrues in whole months on the drawn balance only", () => {
  const s = setup();
  const id = s.funded();

  s.clock.now = START + MONTH - 1n;
  assert.deepEqual(s.balance(id), [10_000n, 0n]);

  s.clock.now = START + MONTH;
  // 10,000 × 8.5% / 12 = 70.83, truncated.
  assert.deepEqual(s.balance(id), [10_000n, 70n]);
  assert.deepEqual(s.balance(id), [10_000n, 70n]);

  // docs/INTEREST_AND_REPAYMENT.md: three months come to 212, not 3 × 70.
  s.clock.now = START + 3n * MONTH;
  assert.equal(s.balance(id)[1], 212n);
});

test("interest does not depend on how often it is charged", () => {
  const base: Mortgage = {
    id: 1n,
    property_id: 1n,
    borrower: address(),
    principal: 50_000n,
    term_months: TERM,
    rate_bps: 857,
    status: "Funded",
    disbursed: 10_007n,
    outstanding: 10_007n,
    interest_accrued: 0n,
    interest_carry: 0n,
    total_repaid: 0n,
    interest_paid: 0n,
    payments_made: 0,
    last_accrued_at: START,
    next_payment_due: START + MONTH,
    created_at: START,
  };
  const stepped = { ...base };
  for (let month = 1n; month <= 6n; month++) accrue(stepped, START + month * MONTH);
  const atOnce = { ...base };
  accrue(atOnce, START + 6n * MONTH);

  assert.equal(stepped.interest_accrued, atOnce.interest_accrued);
  assert.equal(stepped.interest_carry, atOnce.interest_carry);
  assert.equal(atOnce.interest_accrued, (10_007n * 857n * 6n) / 120_000n);
});

// ─── Repayment ───────────────────────────────────────────────────────

test("a payment clears interest before principal", () => {
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;

  // The worked example: 70 interest plus a 416 slice of the facility.
  assert.equal(s.due(id), 486n);
  s.repay(id, 486n);

  const m = s.mortgage(id);
  assert.equal(m.interest_accrued, 0n);
  assert.equal(m.interest_paid, 70n);
  assert.equal(m.outstanding, 9_584n);
  assert.equal(m.payments_made, 1);
  assert.equal(m.status, "Repaying");
  assert.equal(m.next_payment_due, START + 2n * MONTH);
  assert.equal(s.read("lending", "claimable_interest", { investor: s.investor }), 70n);
});

test("a payment short of the instalment is refused", () => {
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;
  rejects(() => s.repay(id, s.due(id) - 1n), "mortgage", "Underpaid");
  rejects(() => s.repay(id, 0n), "mortgage", "InvalidAmount");
  s.repay(id, s.due(id));
});

test("only the borrower can sign a repayment", () => {
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;
  assert.throws(() => s.call("mortgage", "repay", { mortgage_id: id, amount: 486n }, address()), AuthError);
});

test("paying more than due shortens the loan", () => {
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;
  s.repay(id, s.due(id) + 5_000n);
  assert.equal(s.mortgage(id).outstanding, 10_000n - 416n - 5_000n);
});

test("a loan can be paid off at any time, and only the payoff is taken", () => {
  const s = setup();
  const id = s.funded();
  s.clock.now = START + MONTH;
  const payoff = s.payoff(id);
  assert.equal(payoff, 10_070n);

  s.repay(id, payoff * 2n);
  assert.equal(s.ledger.token.balance(s.borrower), -payoff);

  const m = s.mortgage(id);
  assert.equal(m.status, "PaidOff");
  assert.equal(m.total_repaid, payoff);
  assert.equal(s.read("registry", "get_status_of", { property_id: s.property }), "Repaid");
  assert.equal(s.read("mortgage", "mortgage_for_property", { property_id: s.property }), null);

  const pool = s.pool();
  assert.equal(pool.total_reserved, 0n);
  assert.equal(pool.total_lent, 0n);
  assert.equal(pool.total_capital, 500_000n);
  assert.equal(pool.total_interest, 70n);

  rejects(() => s.repay(id, 100n), "mortgage", "WrongStatus");
  assert.equal(s.call("lending", "claim_interest", { investor: s.investor }, s.investor), 70n);
});

// ─── Default ─────────────────────────────────────────────────────────

test("a loan defaults only after grace has run out", () => {
  const s = setup();
  const id = s.funded();
  const markDefault = () => s.call("mortgage", "mark_default", { mortgage_id: id }, address());

  rejects(markDefault, "mortgage", "NotInArrears");
  s.clock.now = START + MONTH + GRACE;
  assert.equal(s.read("mortgage", "is_defaultable", { mortgage_id: id }), false);
  rejects(markDefault, "mortgage", "NotInArrears");

  s.clock.now = START + MONTH + GRACE + 1n;
  assert.equal(s.read("mortgage", "is_defaultable", { mortgage_id: id }), true);
  markDefault();

  assert.equal(s.mortgage(id).status, "Defaulted");
  assert.equal(s.read("registry", "get_status_of", { property_id: s.property }), "Defaulted");
  const pool = s.pool();
  assert.equal(pool.total_written_off, 10_000n);
  assert.equal(pool.total_reserved, 0n);
  assert.equal(pool.total_lent, 0n);

  rejects(markDefault, "mortgage", "WrongStatus");
  rejects(() => s.repay(id, 1_000n), "mortgage", "WrongStatus");
});

test("paying on time keeps a loan out of default", () => {
  const s = setup();
  const id = s.funded();
  for (let month = 1n; month < 4n; month++) {
    s.clock.now = START + month * MONTH;
    s.repay(id, s.due(id));
    assert.equal(s.read("mortgage", "is_defaultable", { mortgage_id: id }), false);
  }
  assert.equal(s.mortgage(id).payments_made, 3);
});

test("an undrawn loan cannot default", () => {
  const s = setup();
  const id = s.approved();
  s.clock.now = START + 12n * MONTH;
  assert.equal(s.read("mortgage", "is_defaultable", { mortgage_id: id }), false);
  rejects(() => s.call("mortgage", "mark_default", { mortgage_id: id }, address()), "mortgage", "WrongStatus");
});

// ─── Transactions ────────────────────────────────────────────────────

test("a call that fails part-way leaves no trace", () => {
  const s = setup();
  const id = s.approved();
  s.signOff(0);
  const events = s.ledger.events.length;

  // Fail the transfer after the registry has already marked the stage released.
  const original = s.ledger.lending.disburse;
  s.ledger.lending.disburse = () => {
    throw new Error("transfer failed");
  };
  assert.throws(() => s.call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address()), /transfer failed/);
  s.ledger.lending.disburse = original;

  assert.equal(s.read("registry", "is_releasable", { property_id: s.property, stage: 0 }), true);
  assert.equal(s.mortgage(id).status, "Approved");
  assert.equal(s.ledger.events.length, events);

  s.call("mortgage", "disburse", { mortgage_id: id, stage: 0 }, address());
  assert.deepEqual(
    s.ledger.events.slice(events).map((e) => `${e.contract}.${e.name}`),
    ["registry.released", "lending.disburse", "registry.status", "mortgage.disbursd"],
  );
});

// ─── Lending pool yield ──────────────────────────────────────────────

function lendingSetup() {
  let ledger = 0;
  const host: Host = { timestamp: () => START, emit: () => {}, nextLedger: () => ++ledger };
  const [admin, mortgagePool, alice, bob, carol] = Array.from({ length: 5 }, address);
  const token = new SimToken(address());
  const pool = new LendingPool(address(), admin, token);
  token.addCustodian(pool.address);
  pool.set_mortgage_pool(new Env(host, [admin]), admin, mortgagePool);
  const as = (signer: string) => new Env(host, [signer]);
  const view = as("");
  const interest = (amount: bigint) => pool.repay(as(mortgagePool), mortgagePool, mortgagePool, 0n, amount);
  return { host, pool, token, mortgagePool, alice, bob, carol, as, view, interest };
}

test("interest splits by shareholding and cannot be farmed by churning", () => {
  const l = lendingSetup();
  l.pool.deposit(l.as(l.alice), l.alice, 60_000n);
  l.pool.deposit(l.as(l.bob), l.bob, 40_000n);
  l.interest(10_000n);
  for (let i = 0; i < 5; i++) {
    l.pool.withdraw(l.as(l.alice), l.alice, 60_000n);
    l.pool.deposit(l.as(l.alice), l.alice, 60_000n);
  }
  assert.equal(l.pool.claimable_interest(l.view, l.alice), 6_000n);
  assert.equal(l.pool.claimable_interest(l.view, l.bob), 4_000n);
});

test("interest earned before a deposit is not shared with it", () => {
  const l = lendingSetup();
  l.pool.deposit(l.as(l.alice), l.alice, 100_000n);
  l.interest(1_000n);
  l.pool.deposit(l.as(l.bob), l.bob, 100_000n);
  assert.equal(l.pool.claimable_interest(l.view, l.bob), 0n);
  l.interest(2_000n);
  assert.equal(l.pool.claimable_interest(l.view, l.alice), 2_000n);
  assert.equal(l.pool.claimable_interest(l.view, l.bob), 1_000n);
});

test("the pool never pays out more interest than it received", () => {
  const l = lendingSetup();
  for (const investor of [l.alice, l.bob, l.carol]) l.pool.deposit(l.as(investor), investor, 1n);
  for (let i = 0; i < 10; i++) l.interest(7n);
  const held = l.token.balance(l.pool.address);
  const paid = [l.alice, l.bob, l.carol].reduce((sum, investor) => sum + l.pool.claim_interest(l.as(investor), investor), 0n);
  assert.ok(paid <= 70n);
  assert.equal(l.token.balance(l.pool.address), held - paid);
});

test("interest with no investors stays in the pool's capital", () => {
  const l = lendingSetup();
  l.interest(500n);
  assert.equal(l.pool.pool_state(l.view).total_capital, 500n);
  assert.equal(l.token.balance(l.pool.address), 500n);
});

test("only the wired mortgage pool moves capital", () => {
  const l = lendingSetup();
  l.pool.deposit(l.as(l.alice), l.alice, 1_000n);
  assert.throws(() => l.pool.reserve(l.as(l.alice), l.alice, 100n), (err: unknown) => err instanceof ContractError && err.errorName === "NotAuthorized");
  assert.throws(
    () => l.pool.disburse(l.as(l.mortgagePool), l.mortgagePool, l.bob, 100n),
    (err: unknown) => err instanceof ContractError && err.errorName === "InsufficientReserved",
  );
});
