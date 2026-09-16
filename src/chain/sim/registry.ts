// PropertyRegistry, ported from stellar-homes-contract
// `contracts/property_registry/src/lib.rs`.
//
// Method names, argument order, check order and error codes follow the Rust so
// the two can be read side by side. Timelocked upgrades and admin handover are
// left out: they exist to change deployed code, which a simulation does not have.

import { ContractError } from "../spec";
import { Env } from "./env";

/** Construction stages: foundation, walls, roofing, finishing, handover. */
export const MILESTONE_COUNT = 5;

/** What `submit_property` writes for a stage with no evidence yet. */
export const ZERO_HASH = "0".repeat(64);

const E = {
  NotAuthorized: 3,
  AlreadySet: 4,
  UnknownProperty: 8,
  NotTrustee: 9,
  NotOracle: 10,
  WrongStatus: 11,
  InvalidValuation: 12,
  InvalidStage: 13,
  NoEvidence: 14,
  AlreadyVerified: 15,
  OutOfOrder: 16,
  MortgagePoolNotSet: 17,
} as const;

function panic(code: number): never {
  throw new ContractError("registry", code);
}

export type PropertyStatus = "Pending" | "Verified" | "Mortgaged" | "Repaid" | "Defaulted";

export interface Property {
  id: bigint;
  trustee: string;
  title_hash: string;
  survey_doc_hash: string;
  usdc_value: bigint;
  status: PropertyStatus;
  verified_by: string | null;
  valued_by: string | null;
}

export interface Milestone {
  stage: number;
  evidence_hash: string;
  verified: boolean;
  released: boolean;
  verified_by: string | null;
}

export interface RegistryState {
  admin: string;
  mortgagePool: string | null;
  nextId: bigint;
  trustees: Set<string>;
  oracles: Set<string>;
  properties: Map<bigint, Property>;
  milestones: Map<string, Milestone>;
}

const milestoneKey = (propertyId: bigint, stage: number) => `${propertyId}:${stage}`;

export class PropertyRegistry {
  readonly address: string;
  state: RegistryState;

  constructor(address: string, admin: string) {
    this.address = address;
    this.state = {
      admin,
      mortgagePool: null,
      nextId: 1n,
      trustees: new Set(),
      oracles: new Set(),
      properties: new Map(),
      milestones: new Map(),
    };
  }

  // --- Administration ---

  set_mortgage_pool(env: Env, admin: string, pool: string): void {
    this.requireAdmin(env, admin);
    if (this.state.mortgagePool !== null) panic(E.AlreadySet);
    this.state.mortgagePool = pool;
  }

  set_trustee(env: Env, admin: string, trustee: string, authorized: boolean): void {
    this.requireAdmin(env, admin);
    setRole(this.state.trustees, trustee, authorized);
    env.publish("registry", "trustee", [trustee, authorized]);
  }

  set_oracle(env: Env, admin: string, oracle: string, authorized: boolean): void {
    this.requireAdmin(env, admin);
    setRole(this.state.oracles, oracle, authorized);
    env.publish("registry", "oracle", [oracle, authorized]);
  }

  // --- Trustee operations ---

  submit_property(env: Env, trustee: string, title_hash: string, survey_doc_hash: string): bigint {
    this.requireTrustee(env, trustee);

    const id = this.state.nextId;
    this.state.nextId = id + 1n;

    this.save({
      id,
      trustee,
      title_hash,
      survey_doc_hash,
      usdc_value: 0n,
      status: "Pending",
      verified_by: null,
      valued_by: null,
    });

    for (let stage = 0; stage < MILESTONE_COUNT; stage++) {
      this.saveMilestone(id, {
        stage,
        evidence_hash: ZERO_HASH,
        verified: false,
        released: false,
        verified_by: null,
      });
    }

    env.publish("registry", "submitted", [id, trustee]);
    return id;
  }

  submit_milestone_evidence(
    env: Env,
    trustee: string,
    property_id: bigint,
    stage: number,
    evidence_hash: string,
  ): void {
    this.requireTrustee(env, trustee);
    const property = this.propertyOf(property_id);
    if (property.trustee !== trustee) panic(E.NotTrustee);

    const milestone = this.milestoneOf(property_id, stage);
    if (milestone.verified) panic(E.AlreadyVerified);
    milestone.evidence_hash = evidence_hash;
    this.saveMilestone(property_id, milestone);

    env.publish("registry", "evidence", [property_id, stage, evidence_hash]);
  }

  // --- Oracle operations ---

  verify_title(env: Env, oracle: string, property_id: bigint): void {
    this.requireOracle(env, oracle);
    const property = this.propertyOf(property_id);
    if (property.status !== "Pending") panic(E.WrongStatus);
    if (property.trustee === oracle) panic(E.NotAuthorized);
    property.status = "Verified";
    property.verified_by = oracle;
    this.save(property);

    env.publish("registry", "title", [property_id, oracle]);
    publishStatus(env, property_id, "Verified");
  }

  set_valuation(env: Env, oracle: string, property_id: bigint, usdc_value: bigint): void {
    this.requireOracle(env, oracle);
    if (usdc_value <= 0n) panic(E.InvalidValuation);
    const property = this.propertyOf(property_id);
    if (property.trustee === oracle) panic(E.NotAuthorized);
    if (property.status === "Pending") panic(E.WrongStatus);
    property.usdc_value = usdc_value;
    property.valued_by = oracle;
    this.save(property);

    env.publish("registry", "valuation", [property_id, oracle, usdc_value]);
  }

  verify_milestone(env: Env, oracle: string, property_id: bigint, stage: number): void {
    this.requireOracle(env, oracle);
    const property = this.propertyOf(property_id);
    if (property.trustee === oracle) panic(E.NotAuthorized);

    const milestone = this.milestoneOf(property_id, stage);
    if (milestone.verified) panic(E.AlreadyVerified);
    if (milestone.evidence_hash === ZERO_HASH) panic(E.NoEvidence);
    if (stage > 0 && !this.milestoneOf(property_id, stage - 1).verified) panic(E.OutOfOrder);

    milestone.verified = true;
    milestone.verified_by = oracle;
    this.saveMilestone(property_id, milestone);

    env.publish("registry", "verified", [property_id, stage, oracle]);
  }

  // --- MortgagePool callbacks ---

  mark_released(env: Env, caller: string, property_id: bigint, stage: number): void {
    env.requireAuth(caller);
    this.requirePool(caller);

    const milestone = this.milestoneOf(property_id, stage);
    if (!milestone.verified) panic(E.WrongStatus);
    if (milestone.released) panic(E.AlreadyVerified);
    milestone.released = true;
    this.saveMilestone(property_id, milestone);

    env.publish("registry", "released", [property_id, stage]);
  }

  mark_mortgaged(env: Env, caller: string, property_id: bigint): void {
    this.transition(env, caller, property_id, "Mortgaged");
  }

  mark_repaid(env: Env, caller: string, property_id: bigint): void {
    this.transition(env, caller, property_id, "Repaid");
  }

  mark_defaulted(env: Env, caller: string, property_id: bigint): void {
    this.transition(env, caller, property_id, "Defaulted");
  }

  // --- Getters ---

  get_property(_env: Env, property_id: bigint): Property {
    return this.propertyOf(property_id);
  }

  get_status_of(_env: Env, property_id: bigint): PropertyStatus {
    return this.propertyOf(property_id).status;
  }

  get_milestone(_env: Env, property_id: bigint, stage: number): Milestone {
    return this.milestoneOf(property_id, stage);
  }

  /** `(trustee, usdc_value, is_verified)` */
  lending_terms(_env: Env, property_id: bigint): [string, bigint, boolean] {
    const property = this.propertyOf(property_id);
    return [property.trustee, property.usdc_value, property.status === "Verified"];
  }

  is_releasable(_env: Env, property_id: bigint, stage: number): boolean {
    const milestone = this.milestoneOf(property_id, stage);
    return milestone.verified && !milestone.released;
  }

  verified_stage_count(_env: Env, property_id: bigint): number {
    let count = 0;
    for (let stage = 0; stage < MILESTONE_COUNT; stage++) {
      if (this.milestoneOf(property_id, stage).verified) count += 1;
    }
    return count;
  }

  is_trustee(_env: Env, trustee: string): boolean {
    return this.state.trustees.has(trustee);
  }

  is_oracle(_env: Env, oracle: string): boolean {
    return this.state.oracles.has(oracle);
  }

  get_admin(_env: Env): string {
    return this.state.admin;
  }

  get_mortgage_pool(_env: Env): string | null {
    return this.state.mortgagePool;
  }

  get_next_id(_env: Env): bigint {
    return this.state.nextId;
  }

  get_milestone_count(_env: Env): number {
    return MILESTONE_COUNT;
  }

  // --- Internals ---

  /** A copy, as reading contract storage gives; writes go through `save`. */
  private propertyOf(propertyId: bigint): Property {
    const property = this.state.properties.get(propertyId);
    if (!property) panic(E.UnknownProperty);
    return { ...property };
  }

  private save(property: Property): void {
    this.state.properties.set(property.id, { ...property });
  }

  private milestoneOf(propertyId: bigint, stage: number): Milestone {
    if (stage >= MILESTONE_COUNT) panic(E.InvalidStage);
    const milestone = this.state.milestones.get(milestoneKey(propertyId, stage));
    if (!milestone) panic(E.UnknownProperty);
    return { ...milestone };
  }

  private saveMilestone(propertyId: bigint, milestone: Milestone): void {
    this.state.milestones.set(milestoneKey(propertyId, milestone.stage), { ...milestone });
  }

  private transition(env: Env, caller: string, propertyId: bigint, status: PropertyStatus): void {
    env.requireAuth(caller);
    this.requirePool(caller);

    const property = this.propertyOf(propertyId);
    let allowed: boolean;
    switch (status) {
      case "Mortgaged":
        allowed = property.status === "Verified";
        break;
      case "Repaid":
      case "Defaulted":
        allowed = property.status === "Mortgaged";
        break;
      default:
        allowed = false;
    }
    if (!allowed) panic(E.WrongStatus);
    property.status = status;
    this.save(property);
    publishStatus(env, propertyId, status);
  }

  private requireAdmin(env: Env, admin: string): void {
    env.requireAuth(admin);
    if (admin !== this.state.admin) panic(E.NotAuthorized);
  }

  private requireTrustee(env: Env, trustee: string): void {
    env.requireAuth(trustee);
    if (!this.state.trustees.has(trustee)) panic(E.NotTrustee);
  }

  private requireOracle(env: Env, oracle: string): void {
    env.requireAuth(oracle);
    if (!this.state.oracles.has(oracle)) panic(E.NotOracle);
  }

  private requirePool(caller: string): void {
    if (this.state.mortgagePool === null) panic(E.MortgagePoolNotSet);
    if (caller !== this.state.mortgagePool) panic(E.NotAuthorized);
  }
}

function setRole(roles: Set<string>, address: string, authorized: boolean): void {
  if (authorized) roles.add(address);
  else roles.delete(address);
}

function publishStatus(env: Env, propertyId: bigint, status: PropertyStatus): void {
  env.publish("registry", "status", [propertyId, status]);
}
