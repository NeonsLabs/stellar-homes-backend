import { SimulatedLedger } from "./sim/ledger";
import { EventQuery, SorobanClient, SubmitResult } from "./soroban";
import { Args, ContractEvent, ContractName, HostError, ReadMethod, WriteMethod } from "./spec";

export type WriteOutcome =
  /** The call ran against the simulated ledger and its effects are live. */
  | { mode: "simulated"; result: unknown; events: ContractEvent[] }
  /** The call is ready to sign: `source` signs `transaction` and posts it to
   *  `/api/tx/submit`. Nothing has happened on-chain yet. */
  | { mode: "soroban"; transaction: string; networkPassphrase: string; source: string };

/** One way into the contracts, whichever ledger is behind it. */
export interface Gateway {
  readonly mode: "simulated" | "soroban";
  readonly contracts: Record<ContractName, string>;
  read<T = unknown, C extends ContractName = ContractName>(contract: C, method: ReadMethod<C>, args?: Args): Promise<T>;
  write<C extends ContractName>(contract: C, method: WriteMethod<C>, args: Args, source: string): Promise<WriteOutcome>;
  submit(signedXdr: string): Promise<SubmitResult>;
  events(query: EventQuery): Promise<ContractEvent[]>;
  /** Ledger time in seconds. */
  now(): bigint;
  /** The in-memory ledger, when that is what is behind the gateway. */
  readonly simulation?: SimulatedLedger;
}

export class SimulatedGateway implements Gateway {
  readonly mode = "simulated";
  readonly simulation: SimulatedLedger;

  constructor(ledger: SimulatedLedger) {
    this.simulation = ledger;
  }

  get contracts() {
    return this.simulation.addresses;
  }

  async read<T>(contract: ContractName, method: string, args: Args = {}): Promise<T> {
    return this.simulation.read(contract, method, args) as T;
  }

  async write(contract: ContractName, method: string, args: Args, source: string): Promise<WriteOutcome> {
    const { result, events } = this.simulation.invoke(contract, method, args, source);
    return { mode: "simulated", result, events };
  }

  async submit(): Promise<SubmitResult> {
    throw new HostError("the simulated ledger applies calls directly; there is nothing to submit");
  }

  async events(query: EventQuery): Promise<ContractEvent[]> {
    const matching = this.simulation.events.filter(
      (e) =>
        (!query.contract || e.contract === query.contract) &&
        (!query.name || e.name === query.name) &&
        (!query.startLedger || e.ledger >= query.startLedger),
    );
    return matching.slice(0, query.limit ?? 100);
  }

  now(): bigint {
    return this.simulation.timestamp();
  }
}

export class SorobanGateway implements Gateway {
  readonly mode = "soroban";
  private readonly client: SorobanClient;

  constructor(client: SorobanClient) {
    this.client = client;
  }

  get contracts() {
    return this.client.contracts;
  }

  async read<T>(contract: ContractName, method: string, args: Args = {}): Promise<T> {
    return (await this.client.read(contract, method, args)) as T;
  }

  async write(contract: ContractName, method: string, args: Args, source: string): Promise<WriteOutcome> {
    const transaction = await this.client.prepare(contract, method, args, source);
    return { mode: "soroban", transaction, networkPassphrase: this.client.networkPassphrase, source };
  }

  submit(signedXdr: string): Promise<SubmitResult> {
    return this.client.submit(signedXdr);
  }

  events(query: EventQuery): Promise<ContractEvent[]> {
    return this.client.events(query);
  }

  /** Wall-clock time; ledgers close every few seconds, so it tracks the
   *  chain closely enough for projections. */
  now(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
  }
}
