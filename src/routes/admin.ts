import { RequestHandler, Router } from "express";
import { Gateway } from "../chain/gateway";
import { Config } from "../config";
import { badRequest, parse, route } from "../http";
import { sendWrite } from "./common";

// Role grants: trustees and oracles live in the registry, underwriters in the
// mortgage pool. Each is an admin call. Upgrades, grace-period changes and
// admin handover stay with the multisig and the Stellar CLI (see the
// contract repo's docs/DEPLOYMENT.md); the backend does not stage them.

const ROLE_CALLS = {
  trustee: { contract: "registry", method: "set_trustee" },
  oracle: { contract: "registry", method: "set_oracle" },
  underwriter: { contract: "mortgage", method: "set_underwriter" },
} as const;

type Role = keyof typeof ROLE_CALLS;

export function createAdminRouter(config: Config, gateway: Gateway, requireAdmin: RequestHandler): Router {
  const router = Router();
  router.use(requireAdmin);

  router.post(
    "/roles",
    route(async (req, res) => {
      const role = req.body.role as Role;
      if (!Object.hasOwn(ROLE_CALLS, role)) throw badRequest(`role must be one of: ${Object.keys(ROLE_CALLS).join(", ")}`);
      const address = parse.address(req.body.address, "address");
      const authorized = parse.bool(req.body.authorized, "authorized");
      const admin = config.adminAddress;

      const { contract, method } = ROLE_CALLS[role];
      const outcome = await gateway.write(contract, method, { admin, [role]: address, authorized }, admin);
      return sendWrite(res, outcome, {
        type: contract === "registry" ? "REGISTRY" : "MORTGAGE",
        action: authorized ? "ROLE_GRANTED" : "ROLE_REVOKED",
        actor: admin,
        details: `${role} ${authorized ? "granted to" : "revoked from"} ${address}`,
      });
    }),
  );

  return router;
}
