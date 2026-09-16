import { Router } from "express";
import { Gateway } from "../chain/gateway";
import { Milestone, MILESTONE_COUNT, Property } from "../chain/sim/registry";
import { parse, route } from "../http";
import { presentMilestone, presentProperty } from "../present";
import { sendWrite } from "./common";

// PropertyRegistry: registration by a trustee, title and valuation by an
// oracle, and the five-stage build schedule.

export function createPropertyRouter(gateway: Gateway): Router {
  const router = Router();

  async function view(id: bigint) {
    const [property, milestones, mortgageId] = await Promise.all([
      gateway.read<Property>("registry", "get_property", { property_id: id }),
      Promise.all(
        Array.from({ length: MILESTONE_COUNT }, (_, stage) =>
          gateway.read<Milestone>("registry", "get_milestone", { property_id: id, stage }),
        ),
      ),
      gateway.read<bigint | null>("mortgage", "mortgage_for_property", { property_id: id }),
    ]);
    return {
      ...presentProperty(property),
      milestones: milestones.map(presentMilestone),
      verifiedStageCount: milestones.filter((m) => m.verified).length,
      mortgageId,
    };
  }

  const propertyId = (raw: string) => parse.u64(raw, "id");

  // List properties. Ids are sequential and properties are never removed.
  router.get(
    "/",
    route(async (req, res) => {
      const offset = parse.u32(req.query.offset ?? 0, "offset");
      const limit = Math.min(100, Math.max(1, parse.u32(req.query.limit ?? 20, "limit")));
      const nextId = await gateway.read<bigint>("registry", "get_next_id");
      const total = Number(nextId - 1n);
      const ids: bigint[] = [];
      for (let i = offset; i < Math.min(total, offset + limit); i++) ids.push(BigInt(i + 1));
      const properties = await Promise.all(
        ids.map((id) => gateway.read<Property>("registry", "get_property", { property_id: id })),
      );
      return res.json({ total, offset, limit, properties: properties.map(presentProperty) });
    }),
  );

  // 1. Submit Property (Trustee)
  router.post(
    "/submit",
    route(async (req, res) => {
      const trustee = parse.address(req.body.trustee, "trustee");
      const titleHash = parse.hash(req.body.titleHash, "titleHash");
      const surveyDocHash = parse.hash(req.body.surveyDocHash, "surveyDocHash");

      const outcome = await gateway.write(
        "registry",
        "submit_property",
        { trustee, title_hash: titleHash, survey_doc_hash: surveyDocHash },
        trustee,
      );
      return sendWrite(
        res,
        outcome,
        (id) => ({
          type: "REGISTRY",
          action: "PROPERTY_SUBMITTED",
          actor: trustee,
          entityKind: "property",
          entityId: id === undefined ? undefined : String(id),
          details: `Title hash ${titleHash}`,
        }),
        { created: true, view: async (id) => ({ property: await view(id as bigint) }) },
      );
    }),
  );

  // Get Property Details, with its build schedule
  router.get(
    "/:id",
    route(async (req, res) => res.json(await view(propertyId(req.params.id)))),
  );

  router.get(
    "/:id/milestones/:stage",
    route(async (req, res) => {
      const milestone = await gateway.read<Milestone>("registry", "get_milestone", {
        property_id: propertyId(req.params.id),
        stage: parse.u32(req.params.stage, "stage"),
      });
      return res.json(presentMilestone(milestone));
    }),
  );

  // 2. Verify Title (Land Registry Oracle)
  router.post(
    "/:id/verify-title",
    route(async (req, res) => {
      const id = propertyId(req.params.id);
      const oracle = parse.address(req.body.oracle, "oracle");
      const outcome = await gateway.write("registry", "verify_title", { oracle, property_id: id }, oracle);
      return sendWrite(
        res,
        outcome,
        {
          type: "REGISTRY",
          action: "TITLE_VERIFIED",
          actor: oracle,
          entityKind: "property",
          entityId: id.toString(),
          details: `Title of property #${id} verified against the land registry`,
        },
        { view: async () => ({ property: await view(id) }) },
      );
    }),
  );

  // 3. Set Property Valuation (Licensed Surveyor / Oracle)
  router.post(
    "/:id/valuation",
    route(async (req, res) => {
      const id = propertyId(req.params.id);
      const oracle = parse.address(req.body.oracle, "oracle");
      const usdcValue = parse.i128(req.body.usdcValue, "usdcValue");
      const outcome = await gateway.write(
        "registry",
        "set_valuation",
        { oracle, property_id: id, usdc_value: usdcValue },
        oracle,
      );
      return sendWrite(
        res,
        outcome,
        {
          type: "REGISTRY",
          action: "VALUATION_SET",
          actor: oracle,
          entityKind: "property",
          entityId: id.toString(),
          details: `Property #${id} valued at ${usdcValue} base units`,
        },
        { view: async () => ({ property: await view(id) }) },
      );
    }),
  );

  // 4. Submit Milestone Evidence (the property's own Trustee)
  router.post(
    "/:id/milestones/submit",
    route(async (req, res) => {
      const id = propertyId(req.params.id);
      const trustee = parse.address(req.body.trustee, "trustee");
      const stage = parse.u32(req.body.stage, "stage");
      const evidenceHash = parse.hash(req.body.evidenceHash, "evidenceHash");
      const outcome = await gateway.write(
        "registry",
        "submit_milestone_evidence",
        { trustee, property_id: id, stage, evidence_hash: evidenceHash },
        trustee,
      );
      return sendWrite(
        res,
        outcome,
        {
          type: "REGISTRY",
          action: "EVIDENCE_SUBMITTED",
          actor: trustee,
          entityKind: "property",
          entityId: id.toString(),
          details: `Stage ${stage} evidence ${evidenceHash}`,
        },
        { view: async () => ({ property: await view(id) }) },
      );
    }),
  );

  // 5. Verify Milestone (Oracle, never the property's trustee; in build order)
  router.post(
    "/:id/milestones/verify",
    route(async (req, res) => {
      const id = propertyId(req.params.id);
      const oracle = parse.address(req.body.oracle, "oracle");
      const stage = parse.u32(req.body.stage, "stage");
      const outcome = await gateway.write("registry", "verify_milestone", { oracle, property_id: id, stage }, oracle);
      return sendWrite(
        res,
        outcome,
        {
          type: "REGISTRY",
          action: "MILESTONE_VERIFIED",
          actor: oracle,
          entityKind: "property",
          entityId: id.toString(),
          details: `Stage ${stage} of property #${id} signed off`,
        },
        { view: async () => ({ property: await view(id) }) },
      );
    }),
  );

  return router;
}
