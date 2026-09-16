import dotenv from "dotenv";
import { createApp, createGateway } from "./app";
import { logEvent } from "./audit";
import { loadConfig } from "./config";

dotenv.config();

const config = loadConfig();
const gateway = createGateway(config);
const app = createApp(config, gateway);

app.listen(config.port, () => {
  console.log(`\n🏠 StellarHomes Backend running on http://localhost:${config.port}`);
  console.log(`📡 Network: ${config.network}`);
  if (gateway.mode === "soroban") {
    console.log(`⛓️  Contracts: registry ${gateway.contracts.registry}`);
    console.log(`              lending  ${gateway.contracts.lending}`);
    console.log(`              mortgage ${gateway.contracts.mortgage}`);
  } else {
    console.log("🧪 Ledger: simulated in memory (no contract ids configured; signatures are not verified)");
    console.log(`   Admin: ${config.adminAddress}${config.adminApiKey ? "" : " — set ADMIN_API_KEY to enable admin calls"}`);
  }
  console.log(`❤️  Health: http://localhost:${config.port}/health\n`);

  logEvent({
    type: "SYSTEM",
    action: "SERVER_START",
    details: `Server started on port ${config.port} against the ${gateway.mode} ledger`,
  });
});

export default app;
