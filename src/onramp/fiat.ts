export interface FiatTransaction {
  id: string;
  provider: "flutterwave" | "paystack";
  amount: number;
  currency: string;
  usdcAmount: bigint;
  status: "pending" | "successful" | "failed";
}

export class FiatOnRampAdapter {
  async initiatePayment(wallet: string, amount: number, currency: string): Promise<{ paymentUrl: string; reference: string }> {
    const reference = `sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      paymentUrl: `https://checkout.example.com/pay/${reference}`,
      reference,
    };
  }

  async verifyTransaction(reference: string): Promise<boolean> {
    return Boolean(reference.startsWith("sh_"));
  }
}

export const fiatAdapter = new FiatOnRampAdapter();
