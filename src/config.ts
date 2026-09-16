import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { ContractName } from "./chain/spec";

export interface Config {
  port: number;
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Set when all three contract ids are configured: the backend reads from
   *  and prepares transactions for the deployed contracts. */
  contracts: Record<ContractName, string> | null;
  /** The contracts' admin. Signs admin transactions on-chain; in simulation it
   *  is the address the admin API key stands in for. */
  adminAddress: string;
  adminApiKey: string | null;
  simulation: {
    graceSecs: bigint;
    underwriter: string | null;
    allowTimeTravel: boolean;
  };
}

const PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
  local: Networks.STANDALONE,
  standalone: Networks.STANDALONE,
};

const CONTRACT_ENV: Record<ContractName, string> = {
  registry: "PROPERTY_REGISTRY_CONTRACT_ID",
  lending: "LENDING_POOL_CONTRACT_ID",
  mortgage: "MORTGAGE_POOL_CONTRACT_ID",
};

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function account(name: string): string | null {
  const value = optional(name);
  if (value && !StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${name} must be a Stellar account address (G...)`);
  }
  return value;
}

export function loadConfig(): Config {
  const network = optional("STELLAR_NETWORK") ?? "testnet";
  const networkPassphrase = optional("STELLAR_NETWORK_PASSPHRASE") ?? PASSPHRASES[network];
  if (!networkPassphrase) {
    throw new Error(`Unknown STELLAR_NETWORK "${network}"; set STELLAR_NETWORK_PASSPHRASE`);
  }

  const ids = Object.fromEntries(
    (Object.keys(CONTRACT_ENV) as ContractName[]).map((c) => [c, optional(CONTRACT_ENV[c])]),
  ) as Record<ContractName, string | null>;
  const configured = Object.values(ids).filter(Boolean).length;
  // The contracts are wired to each other once, at deploy. Pointing the
  // backend at only some of them would mix two deployments.
  if (configured !== 0 && configured !== 3) {
    throw new Error(`Set all three of ${Object.values(CONTRACT_ENV).join(", ")}, or none to run the simulated ledger`);
  }
  for (const c of Object.keys(ids) as ContractName[]) {
    if (ids[c] && !StrKey.isValidContract(ids[c]!)) throw new Error(`${CONTRACT_ENV[c]} is not a contract id (C...)`);
  }
  const contracts = configured === 3 ? (ids as Record<ContractName, string>) : null;

  const adminAddress = account("ADMIN_ADDRESS");
  if (contracts && !adminAddress) {
    throw new Error("ADMIN_ADDRESS is required with deployed contracts: admin transactions are prepared for it to sign");
  }
  if (!contracts && process.env.NODE_ENV === "production" && process.env.ALLOW_SIMULATED_LEDGER !== "true") {
    throw new Error(
      "Refusing to run the simulated ledger in production: it does not verify signatures. " +
        "Configure the contract ids, or set ALLOW_SIMULATED_LEDGER=true for a demo.",
    );
  }

  return {
    port: Number(process.env.PORT) || 4000,
    network,
    rpcUrl: optional("STELLAR_RPC_URL") ?? "https://soroban-testnet.stellar.org",
    networkPassphrase,
    contracts,
    adminAddress: adminAddress ?? Keypair.random().publicKey(),
    adminApiKey: optional("ADMIN_API_KEY"),
    simulation: {
      graceSecs: BigInt(optional("GRACE_SECS") ?? "1209600"),
      underwriter: account("UNDERWRITER_ADDRESS"),
      allowTimeTravel: process.env.ALLOW_TIME_TRAVEL === "true",
    },
  };
}
