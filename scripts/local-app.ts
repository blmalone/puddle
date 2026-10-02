import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brand } from './brand.ts';
import { createEnvironment, createRecipient, prepareDeposit, fund, settle, decryptDeposit } from './harness.ts';
import type { PreparedDeposit } from './types.ts';
import type { TransactionReceipt } from 'ethers';
import { gasFee, quoteAmount } from '../app/shared.ts';
import type { AppState } from '../app/shared.ts';
import { createRecoveryFile } from './recovery-file.ts';
import { mined, recoveryTransaction } from '../protocols/deposit.ts';

class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  let tooLarge = false;
  for await (const chunk of request) {
    if (!tooLarge) body += String(chunk);
    if (body.length > 4_096) { tooLarge = true; body = ''; }
  }
  if (tooLarge) throw new RequestError('Request is too large.', 413);
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RequestError('Expected a JSON object.'); }
}

export async function startLocalApp(port = 5173) {
  // A fresh isolated chain and test identity on every start. No live RPC or signing keys.
  const env = await createEnvironment();
  try {
    assert.equal(await env.pool.shieldFee(), 25n, 'Local quote must match the pool fee');
    const recipient = await createRecipient();
    const state: AppState = {
      recipient: recipient.address, recovery: await env.recovery.getAddress(),
      relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress(),
      token: await env.token.getAddress(), pool: await env.pool.getAddress(),
      factory: await env.factory.getAddress(), privateBalance: '0', deposit: null,
    };
    let prepared: PreparedDeposit | undefined;
    let shieldReceipt: TransactionReceipt | undefined;
    let busy = false;
    let task: Promise<void> | undefined;

    function runTask(work: () => Promise<void>) {
      busy = true;
      task = work().catch(error => {
        console.error('Local deposit failed:', error instanceof Error ? error.message : 'Unknown error');
        assert(state.deposit);
        state.deposit.phase = 'error';
        state.deposit.error = shieldReceipt
          ? 'Shielding confirmed, but receipt verification failed. Retry verification.'
          : 'The deposit could not finish. Retry shielding or recover your test tokens.';
      }).finally(() => { busy = false; });
    }

    async function relay() {
      assert(prepared && state.deposit);
      if (!shieldReceipt) {
        state.deposit.phase = 'shielding';
        shieldReceipt = await settle(env, prepared, gasFee);
        state.deposit.shieldingTx = shieldReceipt.hash;
      }
      state.deposit.phase = 'verifying';
      const note = await decryptDeposit(env, recipient, shieldReceipt);
      const quote = state.deposit.quote;
      assert.equal(note.amount + note.fee + BigInt(quote.serviceFee) + gasFee, BigInt(quote.amount));
      assert.equal(note.amount.toString(), quote.received);
      assert.equal(await env.token.balanceOf(prepared.address), 0n);
      assert.equal(await env.token.allowance(prepared.address, state.pool), 0n);
      state.deposit.received = String(note.amount);
      state.deposit.commitment = note.commitment;
      state.privateBalance = String(BigInt(state.privateBalance) + note.amount);
      state.deposit.phase = 'complete';
      delete state.deposit.error;
    }

    const files = new Map([
      ['/', ['.cache/ui/index.html', 'text/html']],
      ['/style.css', ['app/style.css', 'text/css']],
      ['/main.js', ['.cache/ui/main.js', 'text/javascript']],
      ['/theme.js', ['.cache/ui/theme.js', 'text/javascript']],
      ['/shared.js', ['.cache/ui/shared.js', 'text/javascript']],
      ['/assets/metamask.svg', ['app/assets/metamask.svg', 'image/svg+xml']],
      ['/assets/rainbow.svg', ['app/assets/rainbow.svg', 'image/svg+xml']],
      ['/assets/rabby.svg', ['app/assets/rabby.svg', 'image/svg+xml']],
      ['/assets/railgun.svg', ['app/assets/railgun.svg', 'image/svg+xml']],
      ['/assets/privacy-pools.svg', ['app/assets/privacy-pools.svg', 'image/svg+xml']],
      ['/assets/chains/eth.png', ['app/assets/chains/eth.png', 'image/png']],
      ['/assets/chains/base.png', ['app/assets/chains/base.png', 'image/png']],
      ['/assets/chains/arbitrum.png', ['app/assets/chains/arbitrum.png', 'image/png']],
      ['/assets/chains/bnb.png', ['app/assets/chains/bnb.png', 'image/png']],
      ['/assets/chains/optimism.png', ['app/assets/chains/optimism.png', 'image/png']],
      ['/assets/chains/robinhood.png', ['app/assets/chains/robinhood.png', 'image/png']],
    ]);
    let actualPort = port;
    const server = createServer((request, response) => {
      void handle(request, response).catch(error => {
        const known = error instanceof RequestError;
        if (!known) console.error('Local request failed:', error instanceof Error ? error.message : 'Unknown error');
        response.writeHead(known ? error.status : 500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: known ? error.message : 'Could not complete this local request.' }));
      });
    });

    async function handle(request: IncomingMessage, response: ServerResponse) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const host = request.headers.host;
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
        throw new RequestError('Use the local application address.', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        throw new RequestError('Cross-origin requests are not allowed.', 403);
      }
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      const sendState = (status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(state));
      };
      if (request.method === 'GET') {
        if (path === '/api/state') return sendState();
        if (path === '/api/recovery') {
          const requested = new URL(request.url!, `http://${host}`).searchParams.get('address');
          if (!prepared || requested !== prepared.address) throw new RequestError('This deposit is no longer active.', 409);
          const file = createRecoveryFile(prepared, prepared.quote.token);
          response.writeHead(200, { 'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${brand.name}-recovery-${prepared.address}.json"` });
          response.end(`${JSON.stringify(file, null, 2)}\n`);
          return;
        }
        const file = files.get(path);
        if (!file) throw new RequestError('Not found.', 404);
        const content = await readFile(new URL(`../${file[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
        response.end(content);
        return;
      }
      if (request.method !== 'POST') throw new RequestError('Method not allowed.', 405);
      if (request.headers.origin !== `http://${host}`
        || request.headers['content-type'] !== 'application/json') {
        throw new RequestError('Use the local application to submit actions.', 403);
      }
      const body = await readBody(request);
      if (busy) throw new RequestError('A deposit action is already running.', 409);
      if (path === '/api/deposits') {
        if (body.protocol !== undefined && body.protocol !== 'railgun') {
          throw new RequestError('This local demo supports RAILGUN only.');
        }
        if (state.deposit && !['complete', 'recovered'].includes(state.deposit.phase)) {
          throw new RequestError('Finish the current deposit first.', 409);
        }
        if (typeof body.amount !== 'string') throw new RequestError('Enter a deposit amount.');
        let quote;
        try { quote = quoteAmount(body.amount); }
        catch (error) { throw new RequestError(error instanceof Error ? error.message : 'Invalid amount.'); }
        busy = true;
        try {
          prepared = await prepareDeposit(env, recipient.address,
            { amount: BigInt(quote.amount), gasFee });
          shieldReceipt = undefined;
          state.deposit = { protocol: prepared.protocol, address: prepared.address, quote, phase: 'ready' };
        } finally { busy = false; }
        return sendState(201);
      }
      const deposit = state.deposit;
      if (!deposit || !prepared || body.address !== deposit.address) {
        throw new RequestError('This deposit is no longer active. Refresh the page.', 409);
      }
      if (path === '/api/fund' && deposit.phase === 'ready') {
        deposit.phase = 'funding';
        runTask(async () => {
          assert.equal(await env.provider.getCode(deposit.address), '0x');
          const receipt = await fund(env, deposit.address, BigInt(deposit.quote.amount));
          deposit.fundingTx = receipt.hash;
          assert.equal(await env.provider.getCode(deposit.address), '0x');
          deposit.phase = 'funded';
          await relay();
        });
        return sendState(202);
      }
      if (path === '/api/relay' && deposit.phase === 'error' && deposit.fundingTx) {
        delete deposit.error;
        runTask(relay);
        return sendState(202);
      }
      if (path === '/api/recover' && deposit.phase === 'error' && !shieldReceipt) {
        deposit.phase = 'recovering';
        runTask(async () => {
          assert(prepared);
          const owner = await env.recovery.getAddress();
          // A fresh address needs deployment first; an existing one can recover immediately.
          const deployed = await env.provider.getCode(prepared.address) !== '0x';
          let receipt = await mined(env.recovery.sendTransaction(await recoveryTransaction(
            env.adapter, prepared, env.provider, owner, prepared.quote.token)));
          if (!deployed) receipt = await mined(env.recovery.sendTransaction(await recoveryTransaction(
            env.adapter, prepared, env.provider, owner, prepared.quote.token)));
          assert(receipt);
          assert.equal(await env.token.balanceOf(deposit.address), 0n);
          deposit.recoveryTx = receipt.hash;
          deposit.phase = 'recovered';
          delete deposit.error;
        });
        return sendState(202);
      }
      throw new RequestError('This action is not available for the current deposit.', 409);
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    actualPort = address.port;
    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${actualPort}`,
      close() {
        return closing ??= (async () => {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await task;
          await env.close();
        })();
      },
    };
  } catch (error) { await env.close(); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Starting ${brand.name} on a fresh local test chain…`);
  const app = await startLocalApp(Number(process.env.PORT ?? 5173));
  console.log(`${brand.name} is ready at ${app.url} — local test funds only.`);
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
