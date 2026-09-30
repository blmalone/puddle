import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startRecoverySite(port = 5175) {
  const root = new URL('../.cache/recovery/', import.meta.url);
  const headers = await readFile(new URL('_headers', root), 'utf8');
  const policy = headers.match(/Content-Security-Policy: (.+)/)?.[1];
  if (!policy) throw new Error('Build the recovery site first.');
  const files = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/main.js', ['main.js', 'text/javascript']], ['/core.js', ['core.js', 'text/javascript']],
    ['/theme.js', ['theme.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
    ['/contracts.json', ['contracts.json', 'application/json']],
    ['/vendor/ethers.js', ['vendor/ethers.js', 'text/javascript']],
    ['/vendor/ethers-LICENSE.md', ['vendor/ethers-LICENSE.md', 'text/plain']],
    ['/LICENSE', ['LICENSE', 'text/plain']],
  ]);
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', policy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-cache');
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = files.get(path);
    if (!file || request.method !== 'GET') { response.writeHead(404); response.end('Not found'); return; }
    void readFile(new URL(file[0], root)).then(content => {
      response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); response.end(content);
    }).catch(() => { response.writeHead(500); response.end('Build the recovery site first.'); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start recovery site.');
  return { url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = await startRecoverySite(Number(process.env.RECOVERY_PORT ?? 5175));
  console.log(`Standalone recovery: ${site.url}`);
  const stop = () => { void site.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
