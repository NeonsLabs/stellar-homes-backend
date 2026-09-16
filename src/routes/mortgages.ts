import { Request, Router } from "express";
import { Gateway } from "../chain/gateway";
import { PoolState } from "../chain/sim/lending";
import { Mortgage, MortgageStatus, MILESTONE_COUNT } from "../chain/sim/mortgage";
import { badRequest, HttpError, parse, route } from "../http";
import { requireKyc } from "../kyc";
import { presentEvent, presentMortgage, presentPoolState, projectSchedule, STAGE_NAMES } from "../present";
import { sendWrite } from "./common";

// MortgagePool: application, underwriting, milestone-gated release,
// repayment and default.

/** The backend's long-standing default rate, and the one the contract tests use. */
const DEFAULT_RATE_BPS = 850;

const STATUSES: MortgageStatus[] = ["Applied", "Approved", "Funded", "Repaying", "PaidOff", "Defaulted"];

/** Stands in as the signer of a permissionless call in simulation, where
 *  nobody needs to pay a fee. */
const ANYONE = "anyone";

export function createMortgageRouter(gateway: Gateway): Router {
  const router = Router();

  const mortgageId = (raw: string) => parse.u64(raw, "id");
  const getMortgage = (id: bigint) => gateway.read<Mortgage>("mortgage", "get_mortgage", { mortgage_id: id });

  async function view(id: bigint) {
    const args = { mortgage_id: id };
    const [mortgage, [outstanding, interestAccrued], amountDue, payoffAmount, isDefaultable, tranches] =
      await Promise.all([
        getMortgage(id),
        gateway.read<[bigint, bigint]>("mortgage", "current_balance", args),
        gateway.read<bigint>("mortgage", "amount_due", args),
        gateway.read<bigint>("mortgage", "payoff_amount", args),
        gateway.read<boolean>("mortgage", "is_defaultable", args),
        Promise.all(
          Array.from({ length: MILESTONE_COUNT }, (_, stage) =>
            gateway.read<bigint>("mortgage", "tranche_amount", { mortgage_id: id, stage }),
          ),
        ),
      ]);
    return {
      ...presentMortgage(mortgage),
      // Interest brought up to date as of now, without writing anything.
      live: { outstanding, interestAccrued, amountDue, payoffAmount, isDefaultable },
      tranches: tranches.map((amount, stage) => ({ stage, name: STAGE_NAMES[stage], amount })),
    };
  }

  /** Who signs, and pays the fee for, a call anyone may make. */
  function permissionlessSource(req: Request): string {
    if (req.body.caller !== undefined) return parse.address(req.body.caller, "caller");
    if (gateway.mode === "soroban") throw badRequest("caller is required: the account that will sign and pay the fee");
    return ANYONE;
  }

  // Pool stats — aggregate view of the pool and, where listable, the loans
  router.get(
    "/pool/stats",
    route(async (_req, res) => {
      const [state, available] = await Promise.all([
        gateway.read<PoolState>("lending", "pool_state"),
        gateway.read<bigint>("lending", "available"),
      ]);
      const loans = gateway.simulation?.listMortgages();
      return res.json({
        pool: { ...presentPoolState(state), available },
        mortgages: loans
          ? {
              total: loans.length,
              byStatus: Object.fromEntries(STATUSES.map((s) => [s, loans.filter((m) => m.status === s).length])),
            }
          : null,
      });
    }),
  );

  // 1. Apply for a mortgage against a verified property
  router.post(
    "/apply",
    route(async (req, res) => {
      const borrower = parse.address(req.body.borrower, "borrower");
      const propertyId = parse.u64(req.body.propertyId, "propertyId");
      const principal = parse.i128(req.body.principal, "principal");
      const termMonths = parse.u32(req.body.termMonths, "termMonths");
      const rateBps = parse.u32(req.body.rateBps ?? DEFAULT_RATE_BPS, "rateBps");
      requireKyc(borrower);

      const outcome = await gateway.write(
        "mortgage",
        "apply",
        { borrower, property_id: propertyId, principal, term_months: termMonths, rate_bps: rateBps },
        borrower,
      );
      return sendWrite(
        res,
        outcome,
        (id) => ({
          type: "MORTGAGE",
          action: "APPLICATION_SUBMITTED",
          actor: borrower,
          entityKind: "mortgage",
          entityId: id === undefined ? undefined : String(id),
          details: `Property #${propertyId}: ${principal} over ${termMonths} months at ${rateBps} bps`,
        }),
        { created: true, view: async (id) => ({ mortgage: await view(id as bigint) }) },
      );
    }),
  );

  // 2. List mortgages (with optional borrower and status filters)
  router.get(
    "/",
    route(async (req, res) => {
      const loans = gateway.simulation?.listMortgages();
      if (!loans) {
        throw new HttpError(
          501,
          "NotSupported",
          "The mortgage pool has no listing getter; on-chain listing needs an indexer. " +
            "Look loans up by id, or by property via GET /api/properties/:id.",
        );
      }
      const { borrower, status } = req.query;
      const results = loans.filter((m) => (!borrower || m.borrower === borrower) && (!status || m.status === status));
      return res.json({ total: results.length, mortgages: results.map(presentMortgage) });
    }),
  );

  // 3. Get mortgage details, with live balance and tranche sizes
  router.get(
    "/:id",
    route(async (req, res) => res.json(await view(mortgageId(req.params.id)))),
  );

  // 4. Projected repayment schedule, computed with the contract's arithmetic
  router.get(
    "/:id/schedule",
    route(async (req, res) => {
      const mortgage = await getMortgage(mortgageId(req.params.id));
      const { rows, clearsInFull } = projectSchedule(mortgage);
      return res.json({
        mortgageId: mortgage.id,
        basis:
          "Constant amortisation, as charged on-chain: each instalment is the month's interest on the drawn " +
          "balance plus principal / termMonths. Assumes every instalment is paid on its due date and nothing " +
          "more is drawn. A projection; the contract is the source of truth.",
        clearsInFull,
        instalments: rows,
      });
    }),
  );

  // 5. Repayment history, from the contract's `repaid` events
  router.get(
    "/:id/repayments",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const mortgage = await getMortgage(id);
      const events = await gateway.events({ contract: "mortgage", name: "repaid", limit: 1000 });
      const repayments = events.filter((e) => e.data.id === id).map(presentEvent);
      return res.json({
        mortgageId: id,
        totalRepaid: mortgage.total_repaid,
        interestPaid: mortgage.interest_paid,
        paymentsMade: mortgage.payments_made,
        // RPC keeps only recent events, so on-chain this can be shorter than
        // paymentsMade; the totals above are always complete.
        complete: repayments.length === mortgage.payments_made,
        repayments: repayments.map((e) => ({ ...e.data, timestamp: e.timestamp, ledger: e.ledger, txHash: e.txHash })),
      });
    }),
  );

  // 6. Approve (Underwriter): commits the whole facility against the pool
  router.post(
    "/:id/approve",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const underwriter = parse.address(req.body.underwriter, "underwriter");
      const outcome = await gateway.write("mortgage", "approve", { underwriter, mortgage_id: id }, underwriter);
      return sendWrite(
        res,
        outcome,
        {
          type: "MORTGAGE",
          action: "APPLICATION_APPROVED",
          actor: underwriter,
          entityKind: "mortgage",
          entityId: id.toString(),
          details: `Mortgage #${id} approved and its facility committed`,
        },
        { view: async () => ({ mortgage: await view(id) }) },
      );
    }),
  );

  // 7. Decline (Underwriter): before approval only; frees the property
  router.post(
    "/:id/decline",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const underwriter = parse.address(req.body.underwriter, "underwriter");
      const outcome = await gateway.write("mortgage", "decline", { underwriter, mortgage_id: id }, underwriter);
      return sendWrite(res, outcome, {
        type: "MORTGAGE",
        action: "APPLICATION_DECLINED",
        actor: underwriter,
        entityKind: "mortgage",
        entityId: id.toString(),
        details: `Mortgage #${id} declined`,
      });
    }),
  );

  // 8. Release a signed-off stage's tranche to the trustee (anyone)
  router.post(
    "/:id/disburse",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const stage = parse.u32(req.body.stage, "stage");
      const source = permissionlessSource(req);
      const outcome = await gateway.write("mortgage", "disburse", { mortgage_id: id, stage }, source);
      return sendWrite(
        res,
        outcome,
        (tranche) => ({
          type: "MORTGAGE",
          action: "FUNDS_DISBURSED",
          actor: source === ANYONE ? undefined : source,
          entityKind: "mortgage",
          entityId: id.toString(),
          details:
            tranche === undefined
              ? `Stage ${stage} tranche`
              : `${tranche} released for stage ${stage} (${STAGE_NAMES[stage]}) to the trustee`,
        }),
        { view: async () => ({ mortgage: await view(id) }) },
      );
    }),
  );

  // 9. Repay (Borrower): at least the instalment due, or the whole payoff
  router.post(
    "/:id/repay",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const borrower = parse.address(req.body.borrower, "borrower");
      const amount = parse.i128(req.body.amount, "amount");
      const outcome = await gateway.write("mortgage", "repay", { mortgage_id: id, amount }, borrower);
      return sendWrite(
        res,
        outcome,
        {
          type: "MORTGAGE",
          action: "REPAYMENT_RECEIVED",
          actor: borrower,
          entityKind: "mortgage",
          entityId: id.toString(),
          details: `Repayment of up to ${amount}`,
        },
        {
          view: async () => {
            const mortgage = await view(id);
            return {
              message: mortgage.status === "PaidOff" ? "Mortgage fully paid off! 🎉" : "Repayment recorded successfully",
              mortgage,
            };
          },
        },
      );
    }),
  );

  // 10. Write off a loan past its grace period (anyone)
  router.post(
    "/:id/default",
    route(async (req, res) => {
      const id = mortgageId(req.params.id);
      const source = permissionlessSource(req);
      const outcome = await gateway.write("mortgage", "mark_default", { mortgage_id: id }, source);
      return sendWrite(
        res,
        outcome,
        {
          type: "MORTGAGE",
          action: "MORTGAGE_DEFAULTED",
          actor: source === ANYONE ? undefined : source,
          entityKind: "mortgage",
          entityId: id.toString(),
          details: `Mortgage #${id} written off after its grace period`,
        },
        { view: async () => ({ mortgage: await view(id) }) },
      );
    }),
  );

  return router;
}
