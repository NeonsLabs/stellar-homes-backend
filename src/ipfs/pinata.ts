import crypto from "crypto";

export interface IpfsPinResult {
  ipfsHash: string;
  pinSize: number;
  timestamp: string;
}

export class PinataClient {
  private apiKey: string;
  private apiSecret: string;
  private gateway: string;

  constructor(apiKey = process.env.PINATA_API_KEY || "mock-api-key", apiSecret = process.env.PINATA_API_SECRET || "mock-secret", gateway = "https://gateway.pinata.cloud/ipfs/") {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.gateway = gateway;
  }

  async pinJSON(metadata: Record<string, any>): Promise<IpfsPinResult> {
    const content = JSON.stringify(metadata);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      ipfsHash: `Qm${hash.slice(0, 44)}`,
      pinSize: Buffer.byteLength(content),
      timestamp: new Date().toISOString(),
    };
  }

  getGatewayUrl(ipfsHash: string): string {
    return `${this.gateway}${ipfsHash}`;
  }
}

export const pinata = new PinataClient();
