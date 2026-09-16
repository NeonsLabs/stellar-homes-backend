import { AuthError, ContractEvent, ContractName, HostError, nameEventData } from "../spec";

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

/** The contracts build with `overflow-checks = true`, so arithmetic that would
 *  leave i128 traps rather than wrapping. bigint never overflows; this is where
 *  the simulation traps instead. */
export function i128(value: bigint): bigint {
  if (value > I128_MAX || value < I128_MIN) throw new HostError("arithmetic overflow");
  return value;
}

export interface Host {
  timestamp(): bigint;
  emit(event: ContractEvent): void;
  nextLedger(): number;
}

/** What a contract call sees of the host: the ledger clock, the addresses that
 *  authorized the call, and the event stream.
 *
 *  Authorization is the signer of the transaction plus every contract on the
 *  call path, which is how Soroban treats a contract calling another with its
 *  own address as `caller`. */
export class Env {
  private readonly host: Host;
  private readonly authorized: ReadonlySet<string>;

  constructor(host: Host, authorized: Iterable<string>) {
    this.host = host;
    this.authorized = new Set(authorized);
  }

  timestamp(): bigint {
    return this.host.timestamp();
  }

  requireAuth(address: string): void {
    if (!this.authorized.has(address)) throw new AuthError(address);
  }

  /** The environment a contract passes on when it calls another contract. */
  calledBy(contractAddress: string): Env {
    return new Env(this.host, [...this.authorized, contractAddress]);
  }

  publish(contract: ContractName, name: string, values: unknown[]): void {
    this.host.emit({
      contract,
      name,
      data: nameEventData(contract, name, values),
      timestamp: this.host.timestamp(),
      ledger: this.host.nextLedger(),
    });
  }
}
