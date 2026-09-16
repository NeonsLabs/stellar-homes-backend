import { HostError } from "../spec";
import { Env, i128 } from "./env";

/** The settlement asset, reduced to what the lending pool uses: `transfer`.
 *
 *  Wallets outside the protocol are treated as funded, since the simulation has
 *  no faucet; their balance is the net of what they have sent and received and
 *  may go negative. Contract balances are enforced exactly as a real token
 *  would, so the pool can never pay out money it does not hold. */
export class SimToken {
  readonly address: string;
  private readonly custodians = new Set<string>();
  balances = new Map<string, bigint>();

  constructor(address: string) {
    this.address = address;
  }

  addCustodian(address: string): void {
    this.custodians.add(address);
  }

  transfer(env: Env, from: string, to: string, amount: bigint): void {
    env.requireAuth(from);
    if (amount < 0n) throw new HostError("negative transfer amount");
    const fromBalance = this.balance(from);
    if (this.custodians.has(from) && fromBalance < amount) {
      throw new HostError(`balance of ${from} is not sufficient to spend`);
    }
    this.balances.set(from, i128(fromBalance - amount));
    this.balances.set(to, i128(this.balance(to) + amount));
  }

  balance(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }
}
