import { Request, Response, NextFunction } from "express";
import { Gateway } from "../chain/gateway";

export type Role = "trustee" | "oracle" | "underwriter" | "investor" | "borrower" | "admin";

export function requireRole(gateway: Gateway, expectedRole: Role) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const caller = (req.headers["x-wallet-address"] as string) || (req.query.caller as string);
    if (!caller) {
      return res.status(401).json({ error: "Unauthorized", message: "Missing wallet authentication" });
    }

    try {
      if (expectedRole === "trustee") {
        const hasRole = await gateway.read<boolean>("registry", "is_trustee", { trustee: caller });
        if (!hasRole) {
          return res.status(403).json({ error: "Forbidden", message: "Wallet is not a registered trustee" });
        }
      } else if (expectedRole === "oracle") {
        const hasRole = await gateway.read<boolean>("registry", "is_oracle", { oracle: caller });
        if (!hasRole) {
          return res.status(403).json({ error: "Forbidden", message: "Wallet is not a registered oracle" });
        }
      }
      (req as any).user = { address: caller, role: expectedRole };
      next();
    } catch (err: any) {
      next(err);
    }
  };
}
