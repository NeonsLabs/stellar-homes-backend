import { Router, Request, RequestHandler, Response } from "express";

// ─── Types ───────────────────────────────────────────────────────────

export const AUDIT_TYPES = ["KYC", "REGISTRY", "LENDING", "MORTGAGE", "TX", "SYSTEM"] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export const ENTITY_KINDS = ["property", "mortgage", "investor"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface AuditEvent {
  id: number;
  type: AuditType;
  action: string;
  actor?: string;       // Stellar address of the user who triggered the event
  entityKind?: EntityKind;
  entityId?: string;    // Property or mortgage id, or an investor's address
  details: string;
  timestamp: string;
}

export type CreateEventInput = Omit<AuditEvent, "id" | "timestamp">;

// ─── In-Memory Store ─────────────────────────────────────────────────

const auditLog: AuditEvent[] = [];
let eventIdCounter = 1;

// ─── Public Logger (used by other modules) ───────────────────────────

export function logEvent(input: CreateEventInput): AuditEvent {
  const event: AuditEvent = {
    id: eventIdCounter++,
    ...input,
    timestamp: new Date().toISOString(),
  };

  auditLog.push(event);
  console.log(`[Audit]: [${event.type}] ${event.action} — ${event.details}`);
  return event;
}

function newestFirst(events: AuditEvent[]): AuditEvent[] {
  return [...events].sort((a, b) => b.id - a.id);
}

// ─── Routes ──────────────────────────────────────────────────────────

export function createAuditRouter(requireAdmin: RequestHandler): Router {
  const auditRouter = Router();

  // 1. Get full audit log (with optional filters)
  auditRouter.get("/", (req: Request, res: Response) => {
    const { type, actor, entityKind, entityId, limit, offset } = req.query;

    let results = auditLog;

    if (type) {
      results = results.filter((e) => e.type === type);
    }
    if (actor) {
      results = results.filter((e) => e.actor === actor);
    }
    if (entityKind) {
      results = results.filter((e) => e.entityKind === entityKind);
    }
    if (entityId) {
      results = results.filter((e) => e.entityId === entityId);
    }
    results = newestFirst(results);

    const offsetNum = Math.max(0, parseInt(offset as string) || 0);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string) || 50));
    const paginated = results.slice(offsetNum, offsetNum + limitNum);

    return res.json({
      total: results.length,
      offset: offsetNum,
      limit: limitNum,
      events: paginated,
    });
  });

  // 2. Get audit log for a specific property, mortgage or investor
  auditRouter.get("/entity/:kind/:id", (req: Request, res: Response) => {
    const { kind, id } = req.params;
    if (!ENTITY_KINDS.includes(kind as EntityKind)) {
      return res.status(400).json({ error: "InvalidRequest", message: `kind must be one of: ${ENTITY_KINDS.join(", ")}` });
    }
    const events = newestFirst(auditLog.filter((e) => e.entityKind === kind && e.entityId === id));

    return res.json({
      entityKind: kind,
      entityId: id,
      total: events.length,
      events,
    });
  });

  // 3. Get audit log for a specific actor (Stellar address)
  auditRouter.get("/actor/:address", (req: Request, res: Response) => {
    const { address } = req.params;
    const events = newestFirst(auditLog.filter((e) => e.actor === address));

    return res.json({
      actor: address,
      total: events.length,
      events,
    });
  });

  // 4. Get a summary/count of events by type
  auditRouter.get("/summary", (_req: Request, res: Response) => {
    const byType = Object.fromEntries(
      AUDIT_TYPES.map((type) => [type, auditLog.filter((e) => e.type === type).length]),
    );

    return res.json({
      total: auditLog.length,
      byType,
      lastEvent: auditLog.length > 0 ? auditLog[auditLog.length - 1] : null,
    });
  });

  // 5. Manually log an event (for external integrations or admin use)
  auditRouter.post("/log", requireAdmin, (req: Request, res: Response) => {
    const { type, action, actor, entityKind, entityId, details } = req.body;

    if (!type || !action || !details) {
      return res.status(400).json({ error: "InvalidRequest", message: "Missing required fields: type, action, details" });
    }
    if (!AUDIT_TYPES.includes(type)) {
      return res.status(400).json({ error: "InvalidRequest", message: `type must be one of: ${AUDIT_TYPES.join(", ")}` });
    }
    if (entityKind !== undefined && !ENTITY_KINDS.includes(entityKind)) {
      return res.status(400).json({ error: "InvalidRequest", message: `entityKind must be one of: ${ENTITY_KINDS.join(", ")}` });
    }

    const event = logEvent({
      type,
      action: String(action),
      actor: actor === undefined ? undefined : String(actor),
      entityKind,
      entityId: entityId === undefined ? undefined : String(entityId),
      details: String(details),
    });

    return res.status(201).json({
      message: "Event logged successfully",
      event,
    });
  });

  return auditRouter;
}
