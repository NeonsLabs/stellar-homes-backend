// LendingPool, ported from stellar-homes-contract
// `contracts/lending_pool/src/lib.rs`.
//
// Method names, argument order, check order and error codes follow the Rust so
// the two can be read side by side. Timelocked upgrades and admin handover are
// left out.

import { ContractError } from "../spec";
import { Env, i128 } from "./env";
import { SimToken } from "./token";

/** Fixed-point scale for `acc_per_share`. */
export const SCALE = 1_000_000_000_000n;

const E = {
  NotAuthorized: 3,
  AlreadySet: 4,
  InvalidAmount: 8,
  InsufficientShares: 9,
  InsufficientAvailable: 10,
  InsufficientReserved: 11,
  MortgagePoolNotSet: 12,
  NothingToClaim: 14,
} as const;

function panic(code: number): never {
  throw new ContractError("lending", code);
}

export interface Position {
  shares: bigint;
  reward_debt: bigint;
  credited: bigint;
}

export interface PoolState {
  total_capital: bigint;
  total_reserved: bigint;
  total_lent: bigint;
  total_interest: bigint;
  total_written_off: bigint;
  total_shares: bigint;
}

export interface LendingState {
  admin: string;
  mortgagePool: string | null;
  positions: Map<string, Position>;
  totals: PoolState;
  acc: bigint;
  carry: bigint;
}

type Total = keyof PoolState;

export class LendingPool {
  readonly address: string;
  private readonly token: SimToken;
  state: LendingState;

  constructor(address: string, admin: string, token: SimToken) {
    this.address = address;
    this.token = token;
    this.state = {
      admin,
      mortgagePool: null,
      positions: new Map(),
      totals: {
        total_capital: 0n,
        total_reserved: 0n,
        total_lent: 0n,
        total_interest: 0n,
        total_written_off: 0n,
        total_shares: 0n,
      },
      acc: 0n,
      carry: 0n,
    };
  }

  // --- Administration ---

  set_mortgage_pool(env: Env, admin: string, pool: string): void {
    this.requireAdmin(env, admin);
    if (this.state.mortgagePool !== null) panic(E.AlreadySet);
    this.state.mortgagePool = pool;
  }

  // --- Investor operations ---

  deposit(env: Env, investor: string, amount: bigint): void {
    env.requireAuth(investor);
    if (amount <= 0n) panic(E.InvalidAmount);

    this.token.transfer(env, investor, this.address, amount);

    const acc = this.state.acc;
    const position = this.positionOf(investor);
    settle(position, acc);
    position.shares = i128(position.shares + amount);
    resetDebt(position, acc);
    this.savePosition(investor, position);

    this.add("total_shares", amount);
    const capital = this.add("total_capital", amount);

    env.publish("lending", "deposit", [investor, amount, capital]);
  }

  withdraw(env: Env, investor: string, amount: bigint): void {
    env.requireAuth(investor);
    if (amount <= 0n) panic(E.InvalidAmount);

    const acc = this.state.acc;
    const position = this.positionOf(investor);
    if (position.shares < amount) panic(E.InsufficientShares);
    if (amount > this.availableOf()) panic(E.InsufficientAvailable);

    settle(position, acc);
    position.shares -= amount;
    resetDebt(position, acc);
    this.savePosition(investor, position);

    this.add("total_shares", -amount);
    const capital = this.add("total_capital", -amount);

    this.token.transfer(env.calledBy(this.address), this.address, investor, amount);

    env.publish("lending", "withdraw", [investor, amount, capital]);
  }

  claim_interest(env: Env, investor: string): bigint {
    env.requireAuth(investor);

    const acc = this.state.acc;
    const position = this.positionOf(investor);
    settle(position, acc);
    const owed = position.credited;
    if (owed <= 0n) panic(E.NothingToClaim);
    position.credited = 0n;
    this.savePosition(investor, position);

    this.token.transfer(env.calledBy(this.address), this.address, investor, owed);

    env.publish("lending", "interest", [investor, owed]);
    return owed;
  }

  // --- MortgagePool operations ---

  reserve(env: Env, caller: string, amount: bigint): void {
    env.requireAuth(caller);
    this.requirePool(caller);
    if (amount <= 0n) panic(E.InvalidAmount);
    if (amount > this.availableOf()) panic(E.InsufficientAvailable);
    const reserved = this.add("total_reserved", amount);
    env.publish("lending", "reserve", [amount, reserved]);
  }

  unreserve(env: Env, caller: string, amount: bigint): void {
    env.requireAuth(caller);
    this.requirePool(caller);
    if (amount <= 0n) panic(E.InvalidAmount);
    if (amount > this.state.totals.total_reserved) panic(E.InsufficientReserved);
    const reserved = this.add("total_reserved", -amount);
    env.publish("lending", "unreserve", [amount, reserved]);
  }

  disburse(env: Env, caller: string, to: string, amount: bigint): void {
    env.requireAuth(caller);
    this.requirePool(caller);
    if (amount <= 0n) panic(E.InvalidAmount);
    if (amount > this.state.totals.total_reserved) panic(E.InsufficientReserved);

    this.add("total_reserved", -amount);
    this.add("total_capital", -amount);
    const lent = this.add("total_lent", amount);

    this.token.transfer(env.calledBy(this.address), this.address, to, amount);

    env.publish("lending", "disburse", [to, amount, lent]);
  }

  repay(env: Env, caller: string, from: string, principal: bigint, interest: bigint): void {
    env.requireAuth(caller);
    this.requirePool(caller);
    if (principal < 0n || interest < 0n || principal + interest <= 0n) panic(E.InvalidAmount);

    this.token.transfer(env, from, this.address, i128(principal + interest));

    if (principal > 0n) {
      this.add("total_capital", principal);
      this.add("total_lent", -principal);
    }
    if (interest > 0n) {
      this.accrueInterest(interest);
      this.add("total_interest", interest);
    }

    env.publish("lending", "repay", [from, principal, interest]);
  }

  write_off(env: Env, caller: string, principal: bigint): void {
    env.requireAuth(caller);
    this.requirePool(caller);
    if (principal <= 0n) panic(E.InvalidAmount);

    this.add("total_lent", -principal);
    const total = this.add("total_written_off", principal);

    env.publish("lending", "writeoff", [principal, total]);
  }

  // --- Getters ---

  available(_env: Env): bigint {
    return this.availableOf();
  }

  shares_of(_env: Env, investor: string): bigint {
    return this.positionOf(investor).shares;
  }

  position_of_investor(_env: Env, investor: string): Position {
    return this.positionOf(investor);
  }

  claimable_interest(_env: Env, investor: string): bigint {
    const position = this.positionOf(investor);
    settle(position, this.state.acc);
    return position.credited;
  }

  pool_state(_env: Env): PoolState {
    return { ...this.state.totals };
  }

  get_admin(_env: Env): string {
    return this.state.admin;
  }

  get_mortgage_pool(_env: Env): string | null {
    return this.state.mortgagePool;
  }

  get_settlement_token(_env: Env): string {
    return this.token.address;
  }

  // --- Internals ---

  private accrueInterest(amount: bigint): void {
    const shares = this.state.totals.total_shares;
    if (shares <= 0n) {
      this.add("total_capital", amount);
      return;
    }
    const scaled = i128(amount * SCALE + this.state.carry);
    this.state.acc = i128(this.state.acc + scaled / shares);
    this.state.carry = scaled % shares;
  }

  private positionOf(investor: string): Position {
    const position = this.state.positions.get(investor);
    return position ? { ...position } : { shares: 0n, reward_debt: 0n, credited: 0n };
  }

  private savePosition(investor: string, position: Position): void {
    this.state.positions.set(investor, { ...position });
  }

  private availableOf(): bigint {
    return this.state.totals.total_capital - this.state.totals.total_reserved;
  }

  private add(key: Total, delta: bigint): bigint {
    const updated = i128(this.state.totals[key] + delta);
    this.state.totals[key] = updated;
    return updated;
  }

  private requireAdmin(env: Env, admin: string): void {
    env.requireAuth(admin);
    if (admin !== this.state.admin) panic(E.NotAuthorized);
  }

  private requirePool(caller: string): void {
    if (this.state.mortgagePool === null) panic(E.MortgagePoolNotSet);
    if (caller !== this.state.mortgagePool) panic(E.NotAuthorized);
  }
}

function settle(position: Position, acc: bigint): void {
  const entitled = i128(position.shares * acc) / SCALE;
  position.credited = i128(position.credited + entitled - position.reward_debt);
  position.reward_debt = entitled;
}

function resetDebt(position: Position, acc: bigint): void {
  position.reward_debt = i128(position.shares * acc) / SCALE;
}
