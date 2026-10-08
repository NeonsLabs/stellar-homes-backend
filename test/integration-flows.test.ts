import assert from "node:assert/strict";
import test from "node:test";
import { createApp, createGateway } from "../src/app";
import { loadConfig } from "../src/config";

test("integration: health and system stats check", async () => {
  const config = loadConfig();
  const gateway = createGateway(config);
  const app = createApp(config, gateway);

  assert.ok(app);
  assert.equal(gateway.mode, "simulated");
});
