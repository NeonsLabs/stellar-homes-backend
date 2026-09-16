import { Router } from "express";
import { Gateway } from "../chain/gateway";
import { PoolState, Position } from "../chain/sim/lending";
import { parse, route } from "../http";
import { requireKyc } from "../kyc";
import { presentPoolState, presentPosition } from "../present";
import { sendWrite } from "./common";

// LendingPool: investors' capital and the interest the mortgages pay it.

export function createPoolRouter(gateway: Gateway): Router {
  const router = Router();

  async function investorView(investor: string) {
    const [position, claimableInterest] = await Promise.all([
      gateway.read<Position>("lending", "position_of_investor", { investor }),
      gateway.read<bigint>("lending", "claimable_interest", { investor }),
    ]);
    return { investor, ...presentPosition(position), claimableInterest };
  }

  router.get(
    "/",
    route(async (_req, res) => {
      const [state, available, settlementToken] = await Promise.all([
        gateway.read<PoolState>("lending", "pool_state"),
        gateway.read<bigint>("lending", "available"),
        gateway.read<string>("lending", "get_settlement_token"),
      ]);
      const sim = gateway.simulation;
      return res.json({
        ...presentPoolState(state),
        // Capital neither committed to an approved mortgage nor lent out.
        available,
        settlementToken,
        heldByPool: sim ? sim.token.balance(sim.lending.address) : undefined,
      });
    }),
  );

  router.get(
    "/investors/:address",
    route(async (req, res) => res.json(await investorView(parse.address(req.params.address, "address")))),
  );

  // Deposit: shares are issued one-for-one with the settlement asset
  router.post(
    "/deposit",
    route(async (req, res) => {
      const investor = parse.address(req.body.investor, "investor");
      const amount = parse.i128(req.body.amount, "amount");
      requireKyc(investor);
      const outcome = await gateway.write("lending", "deposit", { investor, amount }, investor);
      return sendWrite(
        res,
        outcome,
        {
          type: "LENDING",
          action: "CAPITAL_DEPOSITED",
          actor: investor,
          entityKind: "investor",
          entityId: investor,
          details: `Deposited ${amount}`,
        },
        { view: async () => ({ position: await investorView(investor) }) },
      );
    }),
  );

  // Withdraw: only capital not committed to an approved mortgage
  router.post(
    "/withdraw",
    route(async (req, res) => {
      const investor = parse.address(req.body.investor, "investor");
      const amount = parse.i128(req.body.amount, "amount");
      const outcome = await gateway.write("lending", "withdraw", { investor, amount }, investor);
      return sendWrite(
        res,
        outcome,
        {
          type: "LENDING",
          action: "CAPITAL_WITHDRAWN",
          actor: investor,
          entityKind: "investor",
          entityId: investor,
          details: `Withdrew ${amount}`,
        },
        { view: async () => ({ position: await investorView(investor) }) },
      );
    }),
  );

  // Claim interest earned and not yet taken
  router.post(
    "/claim",
    route(async (req, res) => {
      const investor = parse.address(req.body.investor, "investor");
      const outcome = await gateway.write("lending", "claim_interest", { investor }, investor);
      return sendWrite(
        res,
        outcome,
        (owed) => ({
          type: "LENDING",
          action: "INTEREST_CLAIMED",
          actor: investor,
          entityKind: "investor",
          entityId: investor,
          details: owed === undefined ? "Interest claim" : `Claimed ${owed} of interest`,
        }),
        { view: async () => ({ position: await investorView(investor) }) },
      );
    }),
  );

  return router;
}
