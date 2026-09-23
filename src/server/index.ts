import { resolve } from 'node:path';
import { serveStatic } from 'hono/bun';
import type { ServerEvent } from '../shared/contracts.ts';
import { createApp } from './app.ts';
import { IrcManager } from './irc.ts';
import { Store } from './store.ts';

const password = process.env.LINGO_PASSWORD;
if (!password) throw new Error('LINGO_PASSWORD must be set');

const host = process.env.LINGO_HOST ?? '127.0.0.1';
const port = Number(process.env.LINGO_PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('LINGO_PORT must be an integer between 1 and 65535');
}
const publicOrigin = process.env.LINGO_PUBLIC_ORIGIN;
if (publicOrigin !== undefined) {
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new Error('LINGO_PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin ||
    parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('LINGO_PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
}


const root = resolve(import.meta.dir, '../..');
const store = new Store(process.env.LINGO_DB_PATH ?? resolve(root, 'local/lingo.sqlite'));
let publish: (event: ServerEvent) => void;
const manager = new IrcManager(store, (event) => publish(event));
const service = createApp(store, manager, password, publicOrigin);
publish = service.publish;

const dist = resolve(root, 'dist');
service.app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
service.app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
service.app.use('/*', serveStatic({ root: dist }));
service.app.get('*', async (c) => {
  if (c.req.path.includes('.')) return c.notFound();
  const index = Bun.file(resolve(dist, 'index.html'));
  if (!await index.exists()) return c.text('Frontend not built', 404);
  return new Response(index.stream(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

const server = Bun.serve({
  hostname: host,
  port,
  fetch: service.app.fetch,
  websocket: service.websocket,
});

try {
  manager.start();
} catch (error) {
  server.stop(true);
  store.close();
  throw error;
}

console.log(`Lingo listening on ${server.url}`);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  manager.stop();
  server.stop(true);
  store.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
