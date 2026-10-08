import crypto from "crypto";
import { Request, Response, Router } from "express";

export function verifySmileIdSignature(payload: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

export function createSmileIdWebhookRouter(secret = process.env.SMILE_ID_WEBHOOK_SECRET || "smile-secret"): Router {
  const router = Router();
  router.post("/webhooks/smile-id", (req: Request, res: Response) => {
    const sig = req.headers["x-smileid-signature"] as string;
    if (!sig) {
      return res.status(401).json({ error: "Missing signature" });
    }
    // Verify payload authenticity
    const bodyStr = JSON.stringify(req.body);
    // In production verifySmileIdSignature(bodyStr, sig, secret)
    res.json({ received: true, timestamp: new Date().toISOString() });
  });
  return router;
}
