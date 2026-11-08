# Contributing to stellar-homes-backend

This is the off-chain half of StellarHomes: an Express and TypeScript API over
the Soroban contracts in [stellar-homes-contract](https://github.com/NeonsLabs/stellar-homes-contract).
It prepares unsigned transactions for the user's wallet to sign. It never holds
a signing key.

## Getting set up

You need Node 22 and npm. No chain, database or wallet is required.

```bash
git clone https://github.com/<you>/stellar-homes-backend
cd stellar-homes-backend
npm install
ADMIN_API_KEY=dev-key ALLOW_TIME_TRAVEL=true npm run dev   # http://localhost:4000
```

That starts the API on a simulated ledger that mirrors the contracts, so you can
try every endpoint locally. The README lists them under "API Reference".

## Picking something to work on

1. Browse the [open issues](https://github.com/NeonsLabs/stellar-homes-backend/issues).
2. Comment on the one you want so two people don't build the same thing.
3. Fork the repo and branch from `main`, for example `feat/rate-limit-kyc`.

If the change touches what the contracts do, read the contract repo's
`docs/ARCHITECTURE.md` and `docs/AUTHORIZATION.md` first. The backend follows
the contracts, never the other way round.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build
```

CI runs exactly these three. If they pass locally, CI should agree.

## Writing the code

- **TypeScript, strict.** No `any` where a real type is available.
- **Match the code next to yours.** HTTP routes live in `src/routes`. Look at an
  existing route before adding a new one.
- **Amounts are integers in the token's smallest unit.** Never use floats for
  money. Use `bigint` or the helpers already in the codebase.
- **No signing keys in the backend.** In soroban mode it returns an unsigned
  transaction and the user's wallet signs it.
- **Validate input at the edge**, before it reaches a contract call.
- **Keep the simulated ledger in step with the contracts.** If you change one,
  change the other and run `npm test`, which compares them.

## Tests

Tests live in `test/` and run on Node's built-in test runner. Name a test for
the behaviour it pins down, not the function it calls, and cover the ways a
request should fail as well as the way it should succeed.

## Commits and PRs

Conventional commits, scoped to the area:

```
feat(kyc): reject a second submission for the same wallet
fix(mortgages): return the live payoff, not the stored balance
docs(readme): explain the signing flow
```

Keep a PR to one change. In the description say what changed and why, and link
the issue with `Fixes #123`.

## Security

Do not open a public issue for a vulnerability. See the contract repo's
[SECURITY.md](https://github.com/NeonsLabs/stellar-homes-contract/blob/main/SECURITY.md).
