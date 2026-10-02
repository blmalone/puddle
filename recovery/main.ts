import { BrowserProvider, ZeroAddress, formatUnits, getAddress, isError } from 'ethers';
import type { Eip1193Provider } from 'ethers';
import { recoveryAsset, checkRecoveryAddress, inspectRecovery, maxRecoveryFileBytes, parseRecoveryFile,
  recoveryTransaction } from './core.ts';
import type { RecoveryArtifacts, RecoveryFile, RecoveryStatus } from './core.ts';

interface WalletProvider extends Eip1193Provider {
  on?(event: string, listener: () => void): void;
}
declare global { interface Window { ethereum?: WalletProvider } }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

let artifacts: RecoveryArtifacts;
let file: RecoveryFile | undefined;
let wallet: WalletProvider | undefined;
let provider: BrowserProvider | undefined;
let status: RecoveryStatus | undefined;
let revision = 0;
let busy = false;

function message(text: string, error = false) {
  const output = element('status');
  output.textContent = text;
  output.classList.toggle('error', error);
}

function invalidate() {
  revision++;
  status = undefined;
  element<HTMLButtonElement>('submit').hidden = true;
  element('balance').textContent = '—';
}

function asset(): string {
  return element<HTMLSelectElement>('asset-kind').value === 'native'
    ? ZeroAddress : getAddress(element<HTMLInputElement>('asset-address').value.trim());
}

function load(text: string) {
  invalidate();
  file = undefined;
  element('review').hidden = true;
  const parsed = parseRecoveryFile(text);
  checkRecoveryAddress(parsed, artifacts);
  file = parsed;
  for (const [id, value] of [
    ['chain', file.chainId], ['deposit', file.depositAddress], ['owner', file.config.recovery], ['factory', file.factory],
  ]) element(id).textContent = value;
  element<HTMLInputElement>('asset-address').value = recoveryAsset(file);
  element<HTMLSelectElement>('asset-kind').value = file.asset === ZeroAddress ? 'native' : 'token';
  element('token-field').hidden = file.asset === ZeroAddress;
  element('review').hidden = false;
  message('File loaded. Connect the recovery wallet to check the contract and balance.');
}

async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  element<HTMLFieldSetElement>('controls').disabled = true;
  try { await work(); }
  catch (error) {
    invalidate();
    const text = isError(error, 'ACTION_REJECTED') ? 'Cancelled in your wallet. You can try again.'
      : isError(error, 'NETWORK_ERROR') ? 'The wallet network changed. Check the balance again.'
        : error instanceof Error ? error.message : 'Could not complete this action.';
    message(text.slice(0, 400), true);
  } finally { busy = false; element<HTMLFieldSetElement>('controls').disabled = false; }
}

async function connect() {
  if (provider) return;
  wallet = window.ethereum;
  if (!wallet) throw new Error('Open this page in a browser with your Ethereum wallet installed.');
  await wallet.request({ method: 'eth_requestAccounts' });
  provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
  const changed = () => {
    invalidate();
    message('Wallet changed. Check the balance again.');
  };
  wallet.on?.('accountsChanged', changed);
  wallet.on?.('chainChanged', changed);
  wallet.on?.('disconnect', changed);
  element('check').textContent = 'Check balance';
}

async function account(): Promise<string> {
  if (!provider || !file) throw new Error('Load your file and connect your recovery wallet.');
  const accounts: string[] = await provider.send('eth_accounts', []);
  if (!accounts[0] || getAddress(accounts[0]) !== file.config.recovery) {
    throw new Error('Select the recovery wallet shown above, then check again.');
  }
  return getAddress(accounts[0]);
}

async function check() {
  if (!file) throw new Error('Load a recovery file first.');
  invalidate();
  const currentRevision = revision;
  await connect();
  await account();
  const checked = await inspectRecovery(provider!, file, artifacts, asset());
  if (currentRevision !== revision) return;
  status = checked;
  element('balance').textContent = `${formatUnits(status.balance, status.decimals)} ${status.symbol}`;
  const submit = element<HTMLButtonElement>('submit');
  submit.hidden = status.balance === 0n;
  submit.textContent = status.deployed ? 'Recover to your wallet' : 'Deploy recovery contract';
  message(status.balance === 0n
    ? 'No balance for this asset. Funds already shielded stay in your protocol wallet.'
    : status.deployed ? 'Ready. Recovery returns this balance to the wallet shown above.'
      : 'Two wallet transactions: deploy the contract, then recover your funds.');
}

element<HTMLInputElement>('file').addEventListener('change', () => { void run(async () => {
  const selected = element<HTMLInputElement>('file').files?.[0];
  if (!selected) return;
  invalidate(); file = undefined; element('review').hidden = true;
  if (selected.size > maxRecoveryFileBytes) throw new Error('Recovery file is too large.');
  load(await selected.text());
}); });
element('load-paste').addEventListener('click', () => { void run(async () => {
  load(element<HTMLTextAreaElement>('paste').value);
}); });
element('asset-kind').addEventListener('change', () => {
  invalidate();
  element('token-field').hidden = element<HTMLSelectElement>('asset-kind').value === 'native';
  message('Check the balance for the selected asset.');
});
element('asset-address').addEventListener('input', () => { invalidate(); message('Check the balance for this token.'); });
element('check').addEventListener('click', () => { void run(check); });
element('submit').addEventListener('click', () => { void run(async () => {
  if (!file || !provider || !status) throw new Error('Check the balance first.');
  const action = status.deployed ? 'recover' : 'deploy';
  const currentRevision = revision;
  const owner = await account();
  const request = await recoveryTransaction(provider, file, artifacts, owner, asset(), action);
  // Recheck immediately before requesting a signature; never reuse an old transaction.
  const signer = await provider.getSigner(owner);
  if (currentRevision !== revision) throw new Error('Wallet changed. Check the balance again.');
  await account();
  await provider.estimateGas(request);
  if (currentRevision !== revision) throw new Error('Wallet changed. Check the balance again.');
  message('Review and confirm the transaction in your wallet.');
  const transaction = await signer.sendTransaction(request);
  element('transaction').textContent = transaction.hash;
  element('transaction-row').hidden = false;
  message('Transaction submitted. Waiting for confirmation…');
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Transaction did not succeed. Check the balance again.');
  if (currentRevision !== revision) return;
  await check();
  if (action === 'recover' && status?.balance === 0n) {
    message('Recovery confirmed. The funds were returned to your recovery wallet.');
  }
}); });

try {
  const response = await fetch('./contracts.json');
  if (!response.ok) throw new Error('Could not load this tool’s contract build. Reload the page.');
  artifacts = await response.json() as RecoveryArtifacts;
  element<HTMLFieldSetElement>('controls').disabled = false;
} catch (error) { message(error instanceof Error ? error.message : 'Could not load the recovery tool.', true); }
