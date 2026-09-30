import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalApp } from '../scripts/local-app.ts';
import { quoteAmount } from '../app/shared.ts';
import type { AppState } from '../app/shared.ts';
import { parseRecoveryFile } from '../recovery/core.ts';

let app: Awaited<ReturnType<typeof startLocalApp>>;
before(async () => { app = await startLocalApp(0); });
after(async () => { if (app) await Promise.all([app.close(), app.close()]); });

async function post(path: string, body: Record<string, unknown>, origin = app.url) {
  return fetch(app.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
}

async function current(): Promise<AppState> {
  return (await fetch(app.url + '/api/state')).json() as Promise<AppState>;
}

async function waitForReceipt() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await current();
    assert.notEqual(state.deposit?.phase, 'error', state.deposit?.error);
    if (state.deposit?.phase === 'complete') return state;
    await delay(200);
  }
  assert.fail('Local deposit did not finish within 20 seconds.');
}

test('serves the local interface without exposing test secrets or allowing cross-site actions', async () => {
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Create address/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await fetch(app.url + '/main.js')).status, 200);
  assert.equal((await fetch(app.url + '/shared.js')).status, 200);
  assert.equal((await fetch(app.url + '/scripts/local-app.ts')).status, 404);
  const state = await current();
  assert.equal(state.privateBalance, '0');
  assert.equal(state.deposit, null);
  assert.match(state.recipient, /^0zk/);
  assert.doesNotMatch(JSON.stringify(state), /privateKey|mnemonic|viewing/);
  assert.equal((await post('/api/deposits', { amount: '100' }, 'https://unrelated.example')).status, 403);
  assert.equal((await post('/api/deposits', { amount: '100' }, 'null')).status, 403);
  assert.equal((await fetch(app.url + '/api/state', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/deposits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"amount":"100"}',
  })).status, 403);
});

test('rejects malformed amounts and does not create or fund a deposit on invalid requests', async () => {
  for (const amount of ['0', '-1', '1e6', '1.1234567', '1000001', 'NaN', '<script>', 100]) {
    assert.equal((await post('/api/deposits', { amount })).status, 400);
  }
  assert.equal((await post('/api/deposits', { amount: '1'.repeat(5_000) })).status, 413);
  assert.equal((await post('/api/fund', { address: '0x0' })).status, 409);
  assert.equal((await current()).deposit, null);
});

test('creates, funds, relays and decrypts real local deposits; duplicate and stale actions cannot send twice', async () => {
  const created = await post('/api/deposits', { amount: '100' });
  assert.equal(created.status, 201);
  const first = await created.json() as AppState;
  assert(first.deposit);
  assert.equal(first.deposit.phase, 'ready');
  assert.deepEqual(first.deposit.quote, quoteAmount('100'));
  assert.equal((await post('/api/deposits', { amount: '25' })).status, 409);
  const address = first.deposit.address;
  const backupResponse = await fetch(app.url + `/api/recovery?address=${address}`);
  assert.equal(backupResponse.status, 200);
  const backup = parseRecoveryFile(await backupResponse.text());
  assert.equal(backup.depositAddress, address);
  assert.equal(backup.config.recovery, first.recovery);
  assert.equal(backup.factory, first.factory);
  assert.equal(backup.chainId, '31337');
  const sends = await Promise.all([post('/api/fund', { address }), post('/api/fund', { address })]);
  assert.deepEqual(sends.map(response => response.status).sort(), [202, 409]);
  const completed = await waitForReceipt();
  assert(completed.deposit);
  assert.equal(completed.deposit.received, '99450750');
  assert.equal(completed.privateBalance, '99450750');
  for (const hash of [completed.deposit.fundingTx, completed.deposit.shieldingTx, completed.deposit.commitment]) {
    assert.match(hash ?? '', /^0x[0-9a-f]{64}$/i);
  }
  assert.equal((await post('/api/fund', { address })).status, 409);
  assert.equal((await post('/api/relay', { address })).status, 409);
  assert.equal((await post('/api/recover', { address })).status, 409);

  const next = await post('/api/deposits', { amount: '25.123456' });
  assert.equal(next.status, 201);
  const second = await next.json() as AppState;
  assert(second.deposit);
  assert.notEqual(second.deposit.address, address);
  assert.equal((await fetch(app.url + `/api/recovery?address=${address}`)).status, 409);
  assert.equal((await post('/api/fund', { address })).status, 409);
  assert.equal((await post('/api/fund', { address: second.deposit.address })).status, 202);
  const final = await waitForReceipt();
  const expected = BigInt(quoteAmount('25.123456').received);
  assert.equal(final.deposit?.received, String(expected));
  assert.equal(final.privateBalance, String(99_450_750n + expected));
});
