export interface ValidatedConfig {
  port: number;
  network: string;
  adminAddress: string;
  rpcUrl?: string;
}

export function validateEnvironment(env: Record<string, string | undefined>): ValidatedConfig {
  const port = parseInt(env.PORT || "3000", 10);
  if (isNaN(port) || port <= 0) {
    throw new Error("Invalid PORT configuration");
  }
  return {
    port,
    network: env.STELLAR_NETWORK || "testnet",
    adminAddress: env.ADMIN_ADDRESS || "GB7BNO7DCICMMQL7BSPCUZVEOOAMJAWAAHA2QHR74IZYXZLHSCLW46XJ",
    rpcUrl: env.SOROBAN_RPC_URL,
  };
}
