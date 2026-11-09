// Liveness, readiness and the per-client rate limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp, createGateway } from "../src/app";
import { Gateway } from "../src/chain/gateway";
import { Config } from "../src/config";

const config: Config = {
  port: 0,
  network: "testnet",
  rpcUrl: "http://unused",
  networkPassphrase: "unused",
  contracts: null,
  adminAddress: Keypair.random().publicKey(),
  adminApiKey: "test-admin-key",
  simulation: { graceSecs: 1_209_600n, underwriter: null, allowTimeTravel: false },
};

async function serve(gateway: Gateway, rateLimitPerMinute?: number) {
  const server = createApp(config, gateway, { rateLimitPerMinute }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test("/healthz answers while the process is up", async () => {
  const app = await serve(createGateway(config));
  try {
    const res = await fetch(`${app.base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).status, "alive");
  } finally {
    app.close();
  }
});

test("/readyz is ready when the contracts can be read", async () => {
  const app = await serve(createGateway(config));
  try {
    const res = await fetch(`${app.base}/readyz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).ready, true);
  } finally {
    app.close();
  }
});

test("/readyz returns 503 when the contracts cannot be read", async () => {
  // A gateway whose reads fail stands in for an unreachable Soroban RPC.
  const broken = createGateway(config);
  broken.read = async () => {
    throw new Error("rpc unreachable");
  };
  const app = await serve(broken);
  try {
    const res = await fetch(`${app.base}/readyz`);
    const body = (await res.json()) as any;
    assert.equal(res.status, 503);
    assert.equal(body.ready, false);
    assert.match(body.reason, /rpc unreachable/);
  } finally {
    app.close();
  }
});

test("a client past its limit gets a 429 with Retry-After", async () => {
  const app = await serve(createGateway(config), 3);
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${app.base}/stats`)).status, 200);
    }
    const blocked = await fetch(`${app.base}/stats`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  } finally {
    app.close();
  }
});

test("health probes are never rate limited", async () => {
  const app = await serve(createGateway(config), 1);
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${app.base}/health`)).status, 200);
      assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
    }
  } finally {
    app.close();
  }
});

test("clients behind the proxy are limited separately", async () => {
  const app = await serve(createGateway(config), 2);
  try {
    const as = (ip: string) => fetch(`${app.base}/stats`, { headers: { "x-forwarded-for": ip } });
    assert.equal((await as("203.0.113.1")).status, 200);
    assert.equal((await as("203.0.113.1")).status, 200);
    assert.equal((await as("203.0.113.1")).status, 429);
    // A different client is unaffected by the first one's usage.
    assert.equal((await as("203.0.113.2")).status, 200);
  } finally {
    app.close();
  }
});
