import { createHash } from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { Args, ContractEvent, ContractName, orderArgs } from "../spec";
import { Env, Host } from "./env";
import { LendingPool } from "./lending";
import { Mortgage, MortgagePool } from "./mortgage";
import { PropertyRegistry } from "./registry";
import { SimToken } from "./token";

/** A stable, valid contract address for a simulated deployment. */
function contractAddress(label: string): string {
  return StrKey.encodeContract(createHash("sha256").update(`stellar-homes-sim:${label}`).digest());
}

export interface SimulatedLedgerOptions {
  admin: string;
  graceSecs: bigint;
  /** Underwriter registered at deploy, as `deploy.sh` does. */
  underwriter?: string;
  /** Wall clock in seconds; injectable for tests. */
  clock?: () => bigint;
}

/** The three contracts deployed and wired together in memory.
 *
 *  Every call is a transaction: if it fails part-way, nothing it wrote is kept,
 *  including its events, exactly as a failed Soroban transaction leaves no
 *  trace. */
export class SimulatedLedger {
  readonly token: SimToken;
  readonly registry: PropertyRegistry;
  readonly lending: LendingPool;
  readonly mortgage: MortgagePool;
  readonly events: ContractEvent[] = [];

  private readonly clock: () => bigint;
  private offsetSecs = 0n;
  private sequence = 0;
  private readonly host: Host;

  constructor(options: SimulatedLedgerOptions) {
    this.clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.host = {
      timestamp: () => this.timestamp(),
      emit: (event) => this.events.push(event),
      nextLedger: () => ++this.sequence,
    };

    const { admin } = options;
    this.token = new SimToken(contractAddress("usdc"));
    this.registry = new PropertyRegistry(contractAddress("registry"), admin);
    this.lending = new LendingPool(contractAddress("lending"), admin, this.token);
    this.mortgage = new MortgagePool(
      contractAddress("mortgage"),
      admin,
      this.registry,
      this.lending,
      options.graceSecs,
    );
    this.token.addCustodian(this.lending.address);

    // The wiring deploy.sh performs.
    const env = new Env(this.host, [admin]);
    this.registry.set_mortgage_pool(env, admin, this.mortgage.address);
    this.lending.set_mortgage_pool(env, admin, this.mortgage.address);
    this.mortgage.set_underwriter(env, admin, options.underwriter ?? admin, true);
  }

  get addresses(): Record<ContractName, string> {
    return {
      registry: this.registry.address,
      lending: this.lending.address,
      mortgage: this.mortgage.address,
    };
  }

  timestamp(): bigint {
    return this.clock() + this.offsetSecs;
  }

  /** Move the ledger clock forward, for exercising interest and default. */
  advanceTime(seconds: bigint): void {
    if (seconds < 0n) throw new Error("the ledger clock only moves forward");
    this.offsetSecs += seconds;
  }

  /** Run a state-changing call as a transaction signed by `signer`. Returns
   *  the call's result and the events it published. */
  invoke(contract: ContractName, method: string, args: Args, signer: string): {
    result: unknown;
    events: ContractEvent[];
  } {
    const snapshot = this.snapshot();
    const firstEvent = this.events.length;
    try {
      const result = this.dispatch(contract, method, args, new Env(this.host, [signer]));
      return { result, events: this.events.slice(firstEvent) };
    } catch (err) {
      this.restore(snapshot);
      this.events.length = firstEvent;
      throw err;
    }
  }

  /** Run a getter. Getters never persist anything, so no snapshot is needed. */
  read(contract: ContractName, method: string, args: Args = {}): unknown {
    return this.dispatch(contract, method, args, new Env(this.host, []));
  }

  /** Every live mortgage record. Not a contract call: the chain has no such
   *  getter, and listing on-chain needs an indexer. */
  listMortgages(): Mortgage[] {
    return [...this.mortgage.state.mortgages.values()].map((m) => ({ ...m }));
  }

  private dispatch(contract: ContractName, method: string, args: Args, env: Env): unknown {
    const ordered = orderArgs(contract, method, args);
    const target = this[contract] as unknown as Record<string, (...a: unknown[]) => unknown>;
    return target[method].call(this[contract], env, ...ordered);
  }

  private snapshot() {
    return structuredClone({
      registry: this.registry.state,
      lending: this.lending.state,
      mortgage: this.mortgage.state,
      balances: this.token.balances,
    });
  }

  private restore(snapshot: ReturnType<SimulatedLedger["snapshot"]>): void {
    this.registry.state = snapshot.registry;
    this.lending.state = snapshot.lending;
    this.mortgage.state = snapshot.mortgage;
    this.token.balances = snapshot.balances;
  }
}
