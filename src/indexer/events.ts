import { Gateway } from "../chain/gateway";

export interface IndexedEvent {
  contractId: string;
  topic: string[];
  data: any;
  ledger: number;
  timestamp: string;
}

export class EventIndexer {
  private lastLedger: number = 0;
  private isRunning: boolean = false;

  constructor(private gateway: Gateway) {}

  async processEvents(startLedger: number): Promise<IndexedEvent[]> {
    this.lastLedger = Math.max(this.lastLedger, startLedger);
    // In simulated or soroban mode, capture processed milestones
    return [];
  }

  getCursor(): number {
    return this.lastLedger;
  }
}
