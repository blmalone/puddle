export const decimals = 6;
export const gasFee = 200_000n;
export const maxGasFee = 500_000n;

export interface Quote {
  amount: string;
  serviceFee: string;
  gasFee: string;
  protocolFee: string;
  received: string;
}

export type Phase = 'ready' | 'funding' | 'funded' | 'shielding' | 'verifying'
  | 'complete' | 'recovering' | 'recovered' | 'error';

export interface DepositView {
  address: string;
  quote: Quote;
  phase: Phase;
  fundingTx?: string;
  shieldingTx?: string;
  recoveryTx?: string;
  received?: string;
  commitment?: string;
  error?: string;
}

export interface AppState {
  recipient: string;
  recovery: string;
  relayer: string;
  feeRecipient: string;
  token: string;
  pool: string;
  factory: string;
  privateBalance: string;
  deposit: DepositView | null;
}

export function quoteAmount(input: string): Quote {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(input)) {
    throw new Error('Enter an amount with up to 6 decimal places.');
  }
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(decimals, '0'));
  if (amount < 1_000_000n || amount > 1_000_000_000_000n) {
    throw new Error('Choose between 1 and 1,000,000 USDC for this test.');
  }
  const serviceFee = amount / 1_000n;
  const net = amount - serviceFee - gasFee;
  const protocolFee = net * 25n / 10_000n;
  return {
    amount: String(amount), serviceFee: String(serviceFee), gasFee: String(gasFee),
    protocolFee: String(protocolFee), received: String(net - protocolFee),
  };
}

export function formatAmount(units: string): string {
  const value = BigInt(units);
  const whole = (value / 1_000_000n).toLocaleString('en-US');
  const fraction = (value % 1_000_000n).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
