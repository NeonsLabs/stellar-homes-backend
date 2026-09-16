import { Router, Request, Response } from "express";
import { logEvent } from "./audit";
import { Gateway } from "./chain/gateway";
import { HttpError, parse, route } from "./http";

// KYC runs entirely off-chain: the contracts never see an identity, only the
// wallet address. The backend refuses to prepare borrowing or investing for
// a wallet that has not passed.

export const KYC_ROLES = ["Borrower", "Investor", "Trustee", "Oracle", "Underwriter"] as const;
type KycRole = (typeof KYC_ROLES)[number];

interface User {
  address: string;
  name: string;
  kycStatus: "None" | "Pending" | "Approved" | "Rejected";
  /** What the user signed up as. On-chain roles are granted separately by the
   *  contracts' admin and are reported alongside. */
  role: KycRole;
}

// In-Memory Database to mimic PostgreSQL for easy local setup
const users: Map<string, User> = new Map();

export function requireKyc(address: string): void {
  if (users.get(address)?.kycStatus !== "Approved") {
    throw new HttpError(403, "KycRequired", `${address} has not completed KYC`);
  }
}

export function createKycRouter(gateway: Gateway): Router {
  const router = Router();

  // 1. KYC / Identity Verification (Smile ID integration mock)
  router.post("/kyc/verify", (req: Request, res: Response) => {
    const { name, documentNumber, documentType, role } = req.body;
    const address = parse.address(req.body.address, "address");

    if (!name || !documentNumber || !documentType || !role) {
      return res.status(400).json({ error: "InvalidRequest", message: "Missing required KYC fields" });
    }
    if (!KYC_ROLES.includes(role)) {
      return res.status(400).json({ error: "InvalidRequest", message: `role must be one of: ${KYC_ROLES.join(", ")}` });
    }

    // Simulate document verification delay & approval
    const user: User = { address, name: String(name), kycStatus: "Approved", role };
    users.set(address, user);

    logEvent({
      type: "KYC",
      action: "USER_VERIFIED",
      actor: address,
      details: `User ${user.name} verified as ${role}`,
    });

    return res.json({
      message: "KYC verification successful",
      user,
    });
  });

  // Get User Profile, with the roles the contracts actually recognise
  router.get(
    "/users/:address",
    route(async (req, res) => {
      const address = parse.address(req.params.address, "address");
      const user = users.get(address);
      if (!user) {
        return res.status(404).json({ error: "NotFound", message: "User not found" });
      }
      return res.json({ ...user, onChainRoles: await onChainRoles(gateway, address) });
    }),
  );

  router.get(
    "/roles/:address",
    route(async (req, res) => {
      const address = parse.address(req.params.address, "address");
      return res.json({ address, ...(await onChainRoles(gateway, address)) });
    }),
  );

  return router;
}

async function onChainRoles(gateway: Gateway, address: string) {
  const [trustee, oracle, underwriter] = await Promise.all([
    gateway.read<boolean>("registry", "is_trustee", { trustee: address }),
    gateway.read<boolean>("registry", "is_oracle", { oracle: address }),
    gateway.read<boolean>("mortgage", "is_underwriter", { underwriter: address }),
  ]);
  return { trustee, oracle, underwriter };
}
