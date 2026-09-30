import { formatAmount, quoteAmount } from './shared.js';
import type { AppState } from './shared.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const amount = element<HTMLInputElement>('amount');
const form = element<HTMLFormElement>('deposit-form');
const menu = element<HTMLDetailsElement>('site-menu');
const menuToggle = element('menu-toggle');

document.addEventListener('click', event => {
  if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    menuToggle.focus();
  }
});
menu.addEventListener('focusout', event => {
  if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) menu.open = false;
});
menu.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('a')) {
    menu.open = false;
    menuToggle.focus();
  }
});

let state: AppState | undefined;
let editing = true;
let submitting = false;
let connected = false;
let actionVersion = 0;
let toastTimer: ReturnType<typeof setTimeout>;
const savedRecoveries = new Set<string>();

function message(text: string) {
  element('error').textContent = text;
  element('error').hidden = !text;
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    element('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element('toast').hidden = true; }, 1_700);
  } catch { message('Copy was unavailable. Select and copy the address manually.'); }
}

function preview() {
  try {
    const quote = quoteAmount(amount.value.trim());
    for (const [id, value] of [['service-fee', quote.serviceFee], ['gas-fee', quote.gasFee],
      ['protocol-fee', quote.protocolFee], ['receive-amount', quote.received],
      ['total-fee', String(BigInt(quote.amount) - BigInt(quote.received))]]) {
      element(id).textContent = `${formatAmount(value)} USDC`;
    }
    amount.removeAttribute('aria-invalid');
    element('amount-hint').textContent = '';
    element('amount-hint').hidden = true;
    element<HTMLButtonElement>('create').disabled = submitting || !connected;
  } catch (error) {
    for (const id of ['service-fee', 'gas-fee', 'protocol-fee', 'receive-amount', 'total-fee']) element(id).textContent = '—';
    element<HTMLButtonElement>('create').disabled = true;
    amount.setAttribute('aria-invalid', 'true');
    element('amount-hint').textContent = error instanceof Error ? error.message : 'Enter a valid amount.';
    element('amount-hint').hidden = false;
  }
}

function receiptRow(label: string, value: string) {
  const row = document.createElement('div');
  const title = document.createElement('dt');
  title.textContent = label;
  const data = document.createElement('dd');
  const code = document.createElement('span');
  code.textContent = `${value.slice(0, 8)}…${value.slice(-6)}`;
  code.title = value;
  const button = document.createElement('button');
  button.className = 'copy-icon';
  button.textContent = '⧉';
  button.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  button.addEventListener('click', () => { void copy(value); });
  data.append(code, button);
  row.append(title, data);
  return row;
}

function render() {
  if (!state) return;
  element('loading').hidden = true;
  form.hidden = !editing;
  element('deposit-panel').hidden = editing;
  const recipient = element<HTMLOutputElement>('recipient');
  recipient.value = `${state.recipient.slice(0, 10)}…${state.recipient.slice(-8)}`;
  recipient.title = state.recipient;
  recipient.setAttribute('aria-label', `Private recipient address ${state.recipient}`);
  preview();
  const deposit = editing ? null : state.deposit;
  const phase = deposit?.phase;
  const complete = phase === 'complete';
  const recovered = phase === 'recovered';
  const active = !!phase && ['funding', 'funded', 'shielding', 'verifying', 'recovering'].includes(phase);
  element('card-label').textContent = editing ? 'NEW DEPOSIT' : complete ? 'DEPOSIT COMPLETE' : recovered ? 'FUNDS RECOVERED' : 'YOUR DEPOSIT';
  if (!deposit) return;
  element('deposit-title').textContent = complete ? 'Received privately.' : recovered ? 'Back in your wallet.'
    : active ? 'On its way.' : phase === 'error' ? 'A little help needed.' : 'Your address is ready.';
  element('deposit-description').textContent = complete ? 'Your deposit is in the test RAILGUN wallet.'
    : recovered ? 'Your unshielded test tokens were returned to the recovery wallet.'
      : active ? 'Your deposit is being shielded.'
        : phase === 'error' ? 'Your deposit stays tied to its fixed recipient and recovery wallet.'
          : 'Send your test tokens here.';
  element('status-icon').textContent = complete || recovered ? '✓' : '↘';
  element('status-icon').classList.toggle('success', complete || recovered);
  element('received-block').hidden = !complete;
  if (deposit.received) element('received-value').textContent = formatAmount(deposit.received);
  element('deposit-address-block').hidden = complete || recovered;
  element('deposit-address').textContent = deposit.address;
  const progress = element('progress-status');
  const descriptions = {
    ready: `Send ${formatAmount(deposit.quote.amount)} USDC · receive ${formatAmount(deposit.quote.received)} USDC`,
    funding: 'Sending a normal token transfer…', funded: 'Transfer confirmed. Waiting for the relayer…',
    shielding: 'Shielding your deposit…', verifying: 'Checking your private receipt…',
    complete: 'Destination, fees and receipt verified.', recovering: 'Returning your test tokens…',
    recovered: 'Recovery complete. No service fee charged.', error: deposit.error ?? 'Deposit paused.',
  };
  progress.replaceChildren();
  if (active) { const spinner = document.createElement('span'); spinner.className = 'spinner'; progress.append(spinner); }
  progress.append(document.createTextNode(descriptions[deposit.phase]));
  element('fund').hidden = phase !== 'ready';
  element<HTMLButtonElement>('fund').disabled = submitting || !connected || !savedRecoveries.has(deposit.address);
  element<HTMLButtonElement>('save-recovery').disabled = submitting || !connected;
  element('save-recovery').textContent = savedRecoveries.has(deposit.address) ? 'Download recovery file again' : 'Save recovery file';
  element('recovery-note').textContent = savedRecoveries.has(deposit.address)
    ? 'Keep this file until all funds have arrived or been recovered.' : 'Save this before sending. Keep it private.';
  element('fund-label').textContent = `Send ${formatAmount(deposit.quote.amount)} test USDC`;
  element('fund-note').hidden = phase !== 'ready';
  element('retry').hidden = phase !== 'error' || !deposit.fundingTx;
  element('retry').textContent = deposit.shieldingTx ? 'Retry verification' : 'Retry shielding';
  element('recover').hidden = phase !== 'error' || !!deposit.shieldingTx;
  for (const id of ['retry', 'recover']) element<HTMLButtonElement>(id).disabled = submitting || !connected;
  element('new-deposit').hidden = !complete && !recovered;
  element('receipt-details').hidden = !deposit.fundingTx && !deposit.recoveryTx;
  const rows = element('receipt-rows');
  const signature = [deposit.address, deposit.fundingTx, deposit.shieldingTx, deposit.recoveryTx, deposit.commitment].join(':');
  if (rows.dataset.signature !== signature) {
    rows.dataset.signature = signature;
    rows.replaceChildren();
    for (const [label, value] of [['Deposit address', deposit.address], ['Token transfer', deposit.fundingTx],
      ['Shielding', deposit.shieldingTx], ['Recovery', deposit.recoveryTx],
      ['Private commitment', deposit.commitment], ['Recovery wallet', state.recovery]] as const) {
      if (value) rows.append(receiptRow(label, value));
    }
  }
}

async function request(path: string, body?: Record<string, string>): Promise<AppState> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) {
    const result: { error?: string } = await response.json();
    throw new Error(result.error ?? 'The local service could not complete the request.');
  }
  return response.json() as Promise<AppState>;
}

async function action(path: string, body: Record<string, string>) {
  if (submitting) return;
  submitting = true;
  actionVersion++;
  message('');
  render();
  try {
    state = await request(path, body);
    editing = false;
    connected = true;
  } catch (error) { message(error instanceof Error ? error.message : 'Could not complete this action.'); }
  finally { submitting = false; render(); }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  try { quoteAmount(amount.value.trim()); }
  catch (error) { message(error instanceof Error ? error.message : 'Check the amount.'); return; }
  void action('/api/deposits', { amount: amount.value.trim() });
});
amount.addEventListener('input', () => { message(''); preview(); });
element('copy-recipient').addEventListener('click', () => { if (state) void copy(state.recipient); });
element('copy-deposit').addEventListener('click', () => { if (state?.deposit) void copy(state.deposit.address); });
element('save-recovery').addEventListener('click', () => { void (async () => {
  const deposit = state?.deposit;
  if (!deposit || submitting) return;
  submitting = true; render(); message('');
  try {
    const response = await fetch(`/api/recovery?address=${encodeURIComponent(deposit.address)}`);
    if (!response.ok) throw new Error('Could not download the recovery file. Try again before sending funds.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url; link.download = `recovery-${deposit.address}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    savedRecoveries.add(deposit.address);
  } catch (error) { message(error instanceof Error ? error.message : 'Could not save recovery file.'); }
  finally { submitting = false; render(); }
})(); });
for (const [id, endpoint] of [['fund', '/api/fund'], ['retry', '/api/relay'], ['recover', '/api/recover']]) {
  element(id).addEventListener('click', () => { if (state?.deposit) void action(endpoint, { address: state.deposit.address }); });
}
element('new-deposit').addEventListener('click', () => {
  editing = true;
  element<HTMLDetailsElement>('receipt-details').open = false;
  message(''); render(); amount.focus();
});

async function poll() {
  try {
    if (!submitting) {
      const version = actionVersion;
      const next = await request('/api/state');
      // A poll started before an action must not replace the action's newer response.
      if (version !== actionVersion) return;
      if (!state) editing = !next.deposit;
      if (state && state.recipient !== next.recipient) {
        editing = !next.deposit;
        message('The local service restarted. A fresh test wallet is ready.');
      }
      state = next;
      if (!connected) message('');
      connected = true;
    }
  } catch {
    connected = false;
    message('Cannot reach the local service. Start it with npm run dev; this page will reconnect.');
  }
  finally {
    render();
    setTimeout(() => { void poll(); }, 700);
  }
}
void poll();
