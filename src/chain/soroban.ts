import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ArgType,
  Args,
  AuthError,
  ContractError,
  ContractEvent,
  ContractName,
  EVENT_FIELDS,
  EVENT_PREFIX,
  HostError,
  nameEventData,
  NativeArg,
  orderArgs,
  signatureOf,
} from "./spec";

/** Simulation needs a source account but never loads it; this is the
 *  all-zero key the SDK's own contract client uses for read calls. */
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const TX_TIMEOUT_SECS = 300;

export interface SubmitResult {
  hash: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  ledger?: number;
  contract: ContractName;
  method: string;
  returnValue?: unknown;
}

export interface EventQuery {
  contract?: ContractName;
  name?: string;
  startLedger?: number;
  limit?: number;
}

export class SorobanClient {
  readonly server: rpc.Server;
  readonly networkPassphrase: string;
  readonly contracts: Record<ContractName, string>;

  constructor(rpcUrl: string, networkPassphrase: string, contracts: Record<ContractName, string>) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.networkPassphrase = networkPassphrase;
    this.contracts = contracts;
  }

  /** Call a getter by simulating it. Nothing is submitted. */
  async read(contract: ContractName, method: string, args: Args = {}): Promise<unknown> {
    const tx = this.build(new Account(READ_SOURCE, "0"), contract, method, args);
    const sim = await this.simulate(tx, contract);
    return sim.result ? normalize(scValToNative(sim.result.retval)) : undefined;
  }

  /** Build, simulate and assemble a state-changing call for `source` to sign.
   *  Returns the unsigned transaction envelope as base64 XDR. */
  async prepare(contract: ContractName, method: string, args: Args, source: string): Promise<string> {
    const account = await this.server.getAccount(source).catch(() => {
      throw new HostError(`source account ${source} does not exist on this network`);
    });
    const tx = this.build(account, contract, method, args);
    const sim = await this.simulate(tx, contract);
    return rpc.assembleTransaction(tx, sim).build().toXDR();
  }

  /** Submit a signed transaction and wait for it to land. Only transactions
   *  that invoke one of the three configured contracts are relayed. */
  async submit(signedXdr: string): Promise<SubmitResult> {
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
      if (!(parsed instanceof Transaction)) throw new Error("fee-bump envelopes are not accepted");
      tx = parsed;
    } catch (err) {
      throw new HostError(`not a transaction for this network: ${(err as Error).message}`);
    }
    const { contract, method } = this.invocationOf(tx);

    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const detail = sent.errorResult?.result().switch().name ?? sent.status;
      throw new HostError(`transaction rejected: ${detail}`);
    }

    const final = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    const base = { hash: sent.hash, contract, method };
    if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        ...base,
        status: "SUCCESS",
        ledger: final.ledger,
        returnValue: final.returnValue ? normalize(scValToNative(final.returnValue)) : undefined,
      };
    }
    if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { ...base, status: "FAILED", ledger: final.ledger };
    }
    return { ...base, status: "PENDING" };
  }

  /** Recent events from the three contracts. RPC retains a few days of
   *  history; anything older needs an indexer. */
  async events(query: EventQuery): Promise<ContractEvent[]> {
    let startLedger = query.startLedger;
    if (startLedger === undefined) {
      // About a day of ledgers at five seconds each.
      const latest = await this.server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 17_280);
    }

    const contracts = query.contract ? [query.contract] : (Object.keys(this.contracts) as ContractName[]);
    const filters = contracts.map((contract) => ({
      type: "contract" as const,
      contractIds: [this.contracts[contract]],
      topics: [[symbolXdr(EVENT_PREFIX[contract]), query.name ? symbolXdr(query.name) : "*"]],
    }));

    const response = await this.server.getEvents({ startLedger, filters, limit: query.limit ?? 100 });
    return response.events.flatMap((event) => {
      const contract = contracts.find((c) => this.contracts[c] === event.contractId?.contractId());
      if (!contract || event.topic.length < 2) return [];
      const name = String(scValToNative(event.topic[1]));
      const value = normalize(scValToNative(event.value));
      const values = Array.isArray(value) && EVENT_FIELDS[contract][name] ? value : [value];
      return [
        {
          contract,
          name,
          data: nameEventData(contract, name, values),
          timestamp: BigInt(Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000)),
          ledger: event.ledger,
          txHash: event.txHash,
        },
      ];
    });
  }

  private build(source: Account, contract: ContractName, method: string, args: Args): Transaction {
    const signature = signatureOf(contract, method)!;
    const values = orderArgs(contract, method, args).map((value, i) => encode(value, signature[i][1]));
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(new Contract(this.contracts[contract]).call(method, ...values))
      .setTimeout(TX_TIMEOUT_SECS)
      .build();
  }

  private async simulate(tx: Transaction, contract: ContractName) {
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw simulationError(sim.error, contract);
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new HostError("contract state this call needs has been archived and must be restored first");
    }
    return sim;
  }

  private invocationOf(tx: Transaction): { contract: ContractName; method: string } {
    const op = tx.operations[0];
    if (tx.operations.length !== 1 || op?.type !== "invokeHostFunction") {
      throw new HostError("expected a single contract invocation");
    }
    const fn = op.func;
    if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      throw new HostError("expected a contract invocation");
    }
    const invoke = fn.invokeContract();
    const target = Address.fromScAddress(invoke.contractAddress()).toString();
    const contract = (Object.keys(this.contracts) as ContractName[]).find((c) => this.contracts[c] === target);
    if (!contract) throw new HostError(`transaction invokes ${target}, which is not a Stellar Homes contract`);
    return { contract, method: invoke.functionName().toString() };
  }
}

function encode(value: NativeArg, type: ArgType): xdr.ScVal {
  switch (type) {
    case "address":
      return Address.fromString(value as string).toScVal();
    case "bool":
      return xdr.ScVal.scvBool(value as boolean);
    case "bytes32":
      return xdr.ScVal.scvBytes(Buffer.from(value as string, "hex"));
    case "u32":
    case "u64":
    case "i128":
      return nativeToScVal(value, { type });
  }
}

function symbolXdr(symbol: string): string {
  return xdr.ScVal.scvSymbol(symbol).toXDR("base64");
}

/** Bring decoded values into the shapes the simulated ledger uses: hashes as
 *  hex, unit enum variants as their name, `None` as null. */
export function normalize(value: unknown, key?: string): unknown {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) {
    // A `#[contracttype]` unit enum decodes as a one-element vector.
    if (key === "status" && value.length === 1 && typeof value[0] === "string") return value[0];
    return value.map((item) => normalize(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  }
  return value;
}

/** Turn a simulation failure into the same error the simulated ledger raises.
 *
 *  The host reports only the code, not which contract raised it, so a failure
 *  inside a cross-contract call is attributed to the contract that was
 *  invoked. The raw diagnostic is kept on the message. */
function simulationError(message: string, contract: ContractName): Error {
  const contractCode = /Error\(Contract, #(\d+)\)/.exec(message);
  if (contractCode) {
    const err = new ContractError(contract, Number(contractCode[1]));
    err.message = `${err.message}: ${firstLine(message)}`;
    return err;
  }
  if (/Error\(Auth,/.test(message)) {
    const account = /(G[A-Z2-7]{55})/.exec(message)?.[1];
    return new AuthError(account && StrKey.isValidEd25519PublicKey(account) ? account : "a required signer");
  }
  return new HostError(firstLine(message));
}

function firstLine(message: string): string {
  return message.split("\n")[0].slice(0, 500);
}
