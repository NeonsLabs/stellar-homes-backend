// The Soroban gateway's offline pieces: argument encoding, decoding into the
// simulated ledger's shapes, and refusing to relay foreign transactions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { normalize, SorobanClient } from "../src/chain/soroban";
import { HostError } from "../src/chain/spec";

const contractId = (label: string) => StrKey.encodeContract(createHash("sha256").update(label).digest());
const contracts = { registry: contractId("r"), lending: contractId("l"), mortgage: contractId("m") };
const client = new SorobanClient("http://127.0.0.1:1", Networks.TESTNET, contracts);

test("a stored property decodes to the simulated ledger's shape", () => {
  const trustee = Keypair.random().publicKey();
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const property = xdr.ScVal.scvMap([
    entry("id", nativeToScVal(7n, { type: "u64" })),
    entry("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Verified")])),
    entry("survey_doc_hash", xdr.ScVal.scvBytes(Buffer.alloc(32, 2))),
    entry("title_hash", xdr.ScVal.scvBytes(Buffer.alloc(32, 1))),
    entry("trustee", Address.fromString(trustee).toScVal()),
    entry("usdc_value", nativeToScVal(100_000n, { type: "i128" })),
    entry("valued_by", xdr.ScVal.scvVoid()),
    entry("verified_by", Address.fromString(trustee).toScVal()),
  ]);

  assert.deepEqual(normalize(scValToNative(property)), {
    id: 7n,
    status: "Verified",
    survey_doc_hash: "02".repeat(32),
    title_hash: "01".repeat(32),
    trustee,
    usdc_value: 100_000n,
    valued_by: null,
    verified_by: trustee,
  });
  // A tuple return is left as an array.
  assert.deepEqual(normalize([5n, 6n]), [5n, 6n]);
});

test("submit relays only calls to the configured contracts", async () => {
  const source = new Account(Keypair.random().publicKey(), "1");
  const foreign = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId("elsewhere")).call("transfer"))
    .setTimeout(30)
    .build();
  await assert.rejects(client.submit(foreign.toXDR()), (err: unknown) => {
    assert.ok(err instanceof HostError);
    assert.match(err.message, /not a Stellar Homes contract/);
    return true;
  });

  await assert.rejects(client.submit("not xdr"), HostError);
});
