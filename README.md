# 🏠 StellarHomes Backend

> Backend service for the StellarHomes platform — diaspora mortgages for building back home, released against the building and settled by Soroban smart contracts on Stellar.

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?style=flat-square&logo=stellar)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey?style=flat-square&logo=express)](https://expressjs.com/)

---

## Overview

The settlement layer lives in [`stellar-homes-contract`](../stellar-homes-contract): a **PropertyRegistry**, a **LendingPool** and a **MortgagePool**. This backend is the off-chain half of the platform, and it follows those contracts exactly:

- **KYC/Identity verification** — Smile ID integration (mocked). Identity never reaches the ledger; borrowing and investing require an approved wallet.
- **Property registry** — trustee registration, oracle title checks and valuations, and the five-stage build schedule (foundation, walls, roofing, finishing, handover).
- **Lending pool** — investor deposits, withdrawals of uncommitted capital, and interest claims.
- **Mortgages** — application, underwriting, milestone-gated disbursement to the trustee, repayment and default.
- **Audit logging** — platform-wide activity trail with filterable queries.

The contract is the source of truth for what is owed. Method names, check order, error codes, events and integer arithmetic here are taken from the contracts, not re-invented.

---

## Two ledgers, one API

| Mode | When | What a write does |
|------|------|-------------------|
| **simulated** | No contract ids configured | Runs against an in-memory port of the three contracts (`src/chain/sim/`) and returns the result and events immediately |
| **soroban** | All three contract ids configured | Simulates the call against the deployed contract and returns an **unsigned transaction** for the acting wallet to sign, then `POST /api/tx/submit` |

Reads work the same in both modes. Configuring only some of the contract ids is refused at startup, because the contracts are wired to each other once, at deploy.

The backend never holds a signing key. On-chain, the wallet's signature is what authorizes a trustee, oracle, underwriter, borrower or investor. **The simulated ledger verifies no signatures**: it trusts the address named in the request, and uses `ADMIN_API_KEY` in place of the admin's signature. It is for local development and demos, and refuses to start with `NODE_ENV=production` unless `ALLOW_SIMULATED_LEDGER=true`.

### Signing flow (soroban mode)

```text
POST /api/mortgages/apply   →  { mode: "soroban", transaction, networkPassphrase, source }
wallet (Freighter etc.) signs `transaction` as `source`
POST /api/tx/submit { transaction: <signed XDR> }  →  { hash, status, returnValue }
```

`/api/tx/submit` relays only transactions that invoke one of the three configured contracts.

---

## Conventions

- **Amounts** are integers in the settlement asset's smallest unit (USDC has 7 decimals, so `10000000` is 1 USDC). Send them as decimal strings (numbers work while they are safe integers). They are always returned as strings, and so are ids and timestamps.
- **Hashes** (title, survey, milestone evidence) are 32-byte digests as 64 hex characters, e.g. a SHA-256 of the document. The documents themselves stay off-chain.
- **Rates** are annual, in basis points: `850` is 8.5%, which is the default. The cap is 3,000 (30%).
- **Loan-to-value** is capped at 80% of the surveyor's valuation.
- **Interest** is constant amortisation, charged monthly (every 30 days) on the balance actually drawn. Each instalment is the month's interest plus `principal / termMonths`. See the contract repo's `docs/INTEREST_AND_REPAYMENT.md`.
- **Errors** from a contract come back as `{ error, code, contract, message }`, e.g. `{ "error": "ExceedsLtv", "code": 14, "contract": "mortgage" }`. Unknown records are 404, authorization failures 403, bad arguments 400, and state conflicts 409. A missing signature is `403 NotSigned`. On-chain the host reports only the code, so an error raised inside a cross-contract call is attributed to the contract that was invoked.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 18 |
| Language | TypeScript 5.4 |
| Framework | Express 4.x |
| Blockchain | Stellar SDK 13.x / Soroban RPC |
| Database | In-memory stores (KYC, audit log); contract state lives on-chain or in the simulated ledger |

---

## Getting Started

```bash
git clone https://github.com/NeonsLabs/stellar-homes-backend.git
cd stellar-homes-backend
npm install
cp .env.example .env
```

### Local development (simulated ledger)

Leave the contract ids empty and set an admin key:

```env
ADMIN_API_KEY=choose-something
ALLOW_TIME_TRAVEL=true
```

```bash
npm run dev
```

The admin address is printed at startup and is also registered as the underwriter, as `deploy.sh` does by default. Grant roles with the admin key:

```bash
curl -X POST localhost:4000/api/admin/roles -H 'x-admin-key: choose-something' \
  -H 'content-type: application/json' \
  -d '{"role":"trustee","address":"G...","authorized":true}'
```

### Against deployed contracts

Deploy with `stellar-homes-contract/scripts/deploy.sh`, then:

```env
STELLAR_NETWORK=testnet
PROPERTY_REGISTRY_CONTRACT_ID=<REGISTRY>
LENDING_POOL_CONTRACT_ID=<LENDING>
MORTGAGE_POOL_CONTRACT_ID=<MORTGAGE>
ADMIN_ADDRESS=<admin or multisig account>
```

### Scripts

```bash
npm run dev         # hot-reload
npm test            # simulated ledger vs the contract test suites, and the API end to end
npm run typecheck
npm run build && npm start
```

---

## API Reference

Write endpoints return `{ mode: "simulated", result, events, ... }` or `{ mode: "soroban", transaction, ... }`, as described above.

### Health & Platform

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health, network and ledger mode |
| `GET` | `/stats` | Contract addresses and the rules read from the mortgage pool (LTV, rate cap, month length, grace) |

### KYC / Identity & Roles

| Method | Endpoint | Body / notes |
|--------|----------|-------------|
| `POST` | `/api/kyc/verify` | `address, name, documentNumber, documentType, role` (`Borrower`, `Investor`, `Trustee`, `Oracle`, `Underwriter`) |
| `GET` | `/api/users/:address` | Profile plus the roles the contracts actually recognise |
| `GET` | `/api/roles/:address` | `{ trustee, oracle, underwriter }` from the contracts |
| `POST` | `/api/admin/roles` | Admin. `role` (`trustee`, `oracle`, `underwriter`), `address`, `authorized` |

### Properties — PropertyRegistry

| Method | Endpoint | Body / notes |
|--------|----------|-------------|
| `GET` | `/api/properties` | `offset`, `limit` |
| `POST` | `/api/properties/submit` | `trustee, titleHash, surveyDocHash`. Registered trustee; creates the five stages |
| `GET` | `/api/properties/:id` | Property, milestones, verified stage count, live mortgage id |
| `GET` | `/api/properties/:id/milestones/:stage` | One stage |
| `POST` | `/api/properties/:id/verify-title` | `oracle`. Never the property's trustee |
| `POST` | `/api/properties/:id/valuation` | `oracle, usdcValue`. Needs a verified title |
| `POST` | `/api/properties/:id/milestones/submit` | `trustee, stage, evidenceHash`. The property's own trustee; replaceable until signed off |
| `POST` | `/api/properties/:id/milestones/verify` | `oracle, stage`. Needs evidence and the previous stage signed off |

### Mortgages — MortgagePool

| Method | Endpoint | Body / notes |
|--------|----------|-------------|
| `POST` | `/api/mortgages/apply` | `borrower, propertyId, principal, termMonths, rateBps?`. KYC required |
| `GET` | `/api/mortgages` | `borrower`, `status`. **Simulated ledger only**: the contract has no listing getter, so on-chain listing needs an indexer |
| `GET` | `/api/mortgages/:id` | Stored loan, `live` balance / amount due / payoff / defaultability, and tranche sizes |
| `GET` | `/api/mortgages/:id/schedule` | Projected instalments using the contract's arithmetic |
| `GET` | `/api/mortgages/:id/repayments` | From `repaid` events. On-chain, RPC keeps only recent events; `complete` says whether the list covers every payment |
| `POST` | `/api/mortgages/:id/approve` | `underwriter`. Commits the whole facility against the pool |
| `POST` | `/api/mortgages/:id/decline` | `underwriter`. Before approval only; frees the property |
| `POST` | `/api/mortgages/:id/disburse` | `stage, caller?`. Anyone; pays the stage's tranche to the trustee. `caller` (the fee payer) is required on-chain |
| `POST` | `/api/mortgages/:id/repay` | `borrower, amount`. At least the instalment due, or the full payoff; overpaying a payoff takes only what is owed |
| `POST` | `/api/mortgages/:id/default` | `caller?`. Anyone, once an instalment is unpaid past the grace period |
| `GET` | `/api/mortgages/pool/stats` | Pool totals, and loan counts by status in simulation |

### Lending Pool — LendingPool

| Method | Endpoint | Body / notes |
|--------|----------|-------------|
| `GET` | `/api/pool` | Capital, reserved, lent, interest, written off, shares, available |
| `GET` | `/api/pool/investors/:address` | Position and claimable interest |
| `POST` | `/api/pool/deposit` | `investor, amount`. KYC required |
| `POST` | `/api/pool/withdraw` | `investor, amount`. Only uncommitted capital |
| `POST` | `/api/pool/claim` | `investor` |

### Chain

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tx/submit` | `transaction` (signed XDR). Soroban mode only |
| `GET` | `/api/events` | `contract` (`registry`, `lending`, `mortgage`), `name`, `startLedger`, `limit`. Named as in the contract repo's `docs/EVENTS.md` |
| `POST` | `/api/dev/advance-time` | `seconds`. Simulated ledger with `ALLOW_TIME_TRAVEL=true` only |

### Audit Log

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/audit/` | Filter by `type`, `actor`, `entityKind`, `entityId`; `limit`/`offset` |
| `GET` | `/api/audit/entity/:kind/:id` | Activity for a `property`, `mortgage` or `investor` |
| `GET` | `/api/audit/actor/:address` | Activity for a specific user |
| `GET` | `/api/audit/summary` | Event count breakdown by type |
| `POST` | `/api/audit/log` | Admin. Manually log an event |

---

## Project Structure

```
stellar-homes-backend/
├── src/
│   ├── index.ts            # Entry point
│   ├── app.ts              # Express app, health and stats
│   ├── config.ts           # Environment and ledger mode
│   ├── http.ts             # Input parsing and error mapping
│   ├── kyc.ts              # KYC and role lookups
│   ├── present.ts          # API shapes and the repayment schedule projection
│   ├── audit.ts            # Platform-wide activity audit log
│   ├── routes/             # properties, mortgages, pool, admin, chain
│   └── chain/
│       ├── spec.ts         # The contract interface: methods, events, errors
│       ├── gateway.ts      # One interface over both ledgers
│       ├── soroban.ts      # Soroban RPC: reads, unsigned transactions, relay, events
│       └── sim/            # In-memory port of the three contracts
└── test/                   # Port vs contract test suites; API end to end
```

---

## Keeping in step with the contracts

`src/chain/spec.ts` lists every contract function the backend calls, with its argument order and types, plus the contracts' events and error codes. `src/chain/sim/` ports the three `lib.rs` files method for method. When the contracts change:

1. Update `spec.ts` and the matching file under `sim/`.
2. Mirror any new or changed contract test in `test/ledger.test.ts`.
3. Run `npm test`.

One contract behaviour worth knowing: `disburse` accepts only `Approved` or `Funded` loans, and the first repayment moves a loan to `Repaying`. On the current contracts, a borrower who starts repaying before every stage has been drawn cannot draw the remaining tranches. The simulation reproduces this, and a test pins it.

---

## License

MIT

---

<p align="center">Built with ☀️ by <strong>NeonsLabs</strong></p>
