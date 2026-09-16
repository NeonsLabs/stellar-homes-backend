// The HTTP API end to end against the simulated ledger: the same lifecycle
// the contract repo's scripts/smoke-testnet.sh drives on testnet.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp, createGateway } from "../src/app";
import { Config } from "../src/config";

const ADMIN_KEY = "test-admin-key";
const MONTH = 2_592_000;
const GRACE = 1_209_600;

const address = () => Keypair.random().publicKey();
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const config: Config = {
  port: 0,
  network: "testnet",
  rpcUrl: "http://unused",
  networkPassphrase: "unused",
  contracts: null,
  adminAddress: address(),
  adminApiKey: ADMIN_KEY,
  simulation: { graceSecs: BigInt(GRACE), underwriter: null, allowTimeTravel: true },
};

let server: Server;
let base: string;

before(async () => {
  server = createApp(config, createGateway(config)).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const post = (path: string, body: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);
const get = (path: string) => call("GET", path);
const admin = { "x-admin-key": ADMIN_KEY };

async function expectOk(p: Promise<{ status: number; body: any }>, status = 200) {
  const res = await p;
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
}

test("a mortgage from registration to payoff", async () => {
  const trustee = address();
  const oracle = address();
  const borrower = address();
  const investor = address();
  const underwriter = config.adminAddress; // registered at deploy, as deploy.sh does

  // Roles are admin calls, guarded by the API key in simulation.
  assert.equal((await post("/api/admin/roles", { role: "trustee", address: trustee, authorized: true })).status, 401);
  await expectOk(post("/api/admin/roles", { role: "trustee", address: trustee, authorized: true }, admin));
  await expectOk(post("/api/admin/roles", { role: "oracle", address: oracle, authorized: true }, admin));
  assert.deepEqual((await expectOk(get(`/api/roles/${trustee}`))).trustee, true);

  // Borrowing and investing need KYC.
  const deposit = { investor, amount: "1000000000" };
  assert.equal((await post("/api/pool/deposit", deposit)).status, 403);
  for (const [who, role] of [[investor, "Investor"], [borrower, "Borrower"]]) {
    await expectOk(post("/api/kyc/verify", { address: who, name: role, documentNumber: "X1", documentType: "passport", role }));
  }
  await expectOk(post("/api/pool/deposit", deposit));

  // Registration, title and valuation.
  const submitted = await expectOk(
    post("/api/properties/submit", { trustee, titleHash: hash(1), surveyDocHash: `0x${hash(2)}` }),
    201,
  );
  const id = submitted.result;
  assert.equal(submitted.property.status, "Pending");
  assert.equal(submitted.property.milestones.length, 5);
  assert.equal(submitted.property.milestones[0].evidenceHash, null);

  // A trustee cannot verify their own title.
  assert.equal((await post(`/api/properties/${id}/verify-title`, { oracle: trustee })).body.error, "NotOracle");
  await expectOk(post(`/api/properties/${id}/verify-title`, { oracle }));
  const valued = await expectOk(post(`/api/properties/${id}/valuation`, { oracle, usdcValue: "1000000000" }));
  assert.equal(valued.property.usdcValue, "1000000000");

  // Above 80% LTV is refused with the contract's error.
  const tooMuch = await post("/api/mortgages/apply", { borrower, propertyId: id, principal: "800000001", termMonths: 120 });
  assert.equal(tooMuch.status, 409);
  assert.deepEqual([tooMuch.body.contract, tooMuch.body.error, tooMuch.body.code], ["mortgage", "ExceedsLtv", 14]);

  const applied = await expectOk(
    post("/api/mortgages/apply", { borrower, propertyId: id, principal: "500000000", termMonths: 120 }),
    201,
  );
  const loan = applied.result;
  assert.equal(applied.mortgage.rateBps, 850);
  assert.equal(applied.mortgage.tranches[4].amount, "100000000");
  assert.equal((await expectOk(get(`/api/properties/${id}`))).mortgageId, loan);

  await expectOk(post(`/api/mortgages/${loan}/approve`, { underwriter }));
  assert.equal((await expectOk(get("/api/pool"))).available, "500000000");

  // Stage 0 must be signed off before it can be drawn.
  const early = await post(`/api/mortgages/${loan}/disburse`, { stage: 0 });
  assert.equal(early.body.error, "StageNotReleasable");
  await expectOk(post(`/api/properties/${id}/milestones/submit`, { trustee, stage: 0, evidenceHash: hash(9) }));
  await expectOk(post(`/api/properties/${id}/milestones/verify`, { oracle, stage: 0 }));
  const drawn = await expectOk(post(`/api/mortgages/${loan}/disburse`, { stage: 0 }));
  assert.equal(drawn.result, "100000000");
  assert.deepEqual(
    drawn.events.map((e: any) => `${e.contract}.${e.name}`),
    ["registry.released", "lending.disburse", "registry.status", "mortgage.disbursd"],
  );
  assert.equal(drawn.events[3].data.trustee, trustee);
  assert.equal(drawn.mortgage.status, "Funded");

  // A month on: interest on the drawn tranche only.
  await expectOk(post("/api/dev/advance-time", { seconds: MONTH }));
  const month1 = await expectOk(get(`/api/mortgages/${loan}`));
  // 100,000,000 × 850 / 120,000 = 708,333 (carry 40,000)
  assert.equal(month1.live.interestAccrued, "708333");
  // Plus the principal slice, 500,000,000 / 120 truncated.
  assert.equal(month1.live.amountDue, String(708_333 + 4_166_666));

  const schedule = await expectOk(get(`/api/mortgages/${loan}/schedule`));
  assert.equal(schedule.clearsInFull, true);
  assert.equal(schedule.instalments[0].payment, month1.live.amountDue);

  // Short payments are refused; the instalment is accepted from the borrower only.
  const short = await post(`/api/mortgages/${loan}/repay`, { borrower, amount: "1" });
  assert.equal(short.body.error, "Underpaid");
  const stranger = await post(`/api/mortgages/${loan}/repay`, { borrower: investor, amount: month1.live.amountDue });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, "NotSigned");
  const paid = await expectOk(post(`/api/mortgages/${loan}/repay`, { borrower, amount: month1.live.amountDue }));
  assert.equal(paid.mortgage.status, "Repaying");

  const investorView = await expectOk(get(`/api/pool/investors/${investor}`));
  assert.equal(investorView.claimableInterest, "708333");

  // Clear it outright.
  const payoff = (await expectOk(get(`/api/mortgages/${loan}`))).live.payoffAmount;
  const closed = await expectOk(post(`/api/mortgages/${loan}/repay`, { borrower, amount: payoff }));
  assert.equal(closed.mortgage.status, "PaidOff");
  assert.equal((await expectOk(get(`/api/properties/${id}`))).status, "Repaid");

  const history = await expectOk(get(`/api/mortgages/${loan}/repayments`));
  assert.equal(history.repayments.length, 2);
  assert.equal(history.complete, true);

  const pool = await expectOk(get("/api/pool"));
  assert.equal(pool.totalReserved, "0");
  assert.equal(pool.totalLent, "0");
  assert.equal(pool.heldByPool, String(1_000_000_000 + 708_333));

  const claimed = await expectOk(post("/api/pool/claim", { investor }));
  assert.equal(claimed.result, "708333");

  const audit = await expectOk(get(`/api/audit/entity/mortgage/${loan}`));
  assert.ok(audit.events.some((e: any) => e.action === "APPLICATION_SUBMITTED"));
});

test("a loan past grace can be written off by anyone", async () => {
  const trustee = address();
  const oracle = address();
  const borrower = address();
  await post("/api/admin/roles", { role: "trustee", address: trustee, authorized: true }, admin);
  await post("/api/admin/roles", { role: "oracle", address: oracle, authorized: true }, admin);
  await post("/api/kyc/verify", { address: borrower, name: "B", documentNumber: "1", documentType: "id", role: "Borrower" });

  const id = (await post("/api/properties/submit", { trustee, titleHash: hash(3), surveyDocHash: hash(4) })).body.result;
  await post(`/api/properties/${id}/verify-title`, { oracle });
  await post(`/api/properties/${id}/valuation`, { oracle, usdcValue: 100_000 });
  const loan = (await post("/api/mortgages/apply", { borrower, propertyId: id, principal: 50_000, termMonths: 12 })).body.result;
  await expectOk(post(`/api/mortgages/${loan}/approve`, { underwriter: config.adminAddress }));
  await post(`/api/properties/${id}/milestones/submit`, { trustee, stage: 0, evidenceHash: hash(5) });
  await post(`/api/properties/${id}/milestones/verify`, { oracle, stage: 0 });
  await expectOk(post(`/api/mortgages/${loan}/disburse`, { stage: 0 }));

  assert.equal((await post(`/api/mortgages/${loan}/default`, {})).body.error, "NotInArrears");
  await expectOk(post("/api/dev/advance-time", { seconds: MONTH + GRACE + 1 }));
  const defaulted = await expectOk(post(`/api/mortgages/${loan}/default`, { caller: address() }));
  assert.equal(defaulted.mortgage.status, "Defaulted");
  assert.equal((await expectOk(get(`/api/properties/${id}`))).status, "Defaulted");

  const stats = await expectOk(get("/api/mortgages/pool/stats"));
  assert.equal(stats.mortgages.byStatus.Defaulted, 1);
  assert.equal(stats.pool.totalWrittenOff, "10000");
});

test("requests are validated before they reach a contract", async () => {
  assert.equal((await post("/api/properties/submit", { trustee: "GD3W...1234", titleHash: hash(1), surveyDocHash: hash(2) })).status, 400);
  assert.equal((await post("/api/properties/submit", { trustee: address(), titleHash: "abc", surveyDocHash: hash(2) })).status, 400);
  assert.equal((await get("/api/properties/99")).body.error, "UnknownProperty");
  assert.equal((await get("/api/mortgages/99")).status, 404);
  assert.equal((await post("/api/tx/submit", { transaction: "AAAA" })).status, 409);
  assert.equal((await post("/api/admin/roles", { role: "toString", address: address(), authorized: true }, admin)).status, 400);
  const stats = await expectOk(get("/stats"));
  assert.equal(stats.ledger, "simulated");
  assert.equal(stats.rules.maxLtvBps, "8000");
});
