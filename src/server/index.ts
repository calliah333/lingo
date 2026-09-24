import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { serveStatic } from 'hono/bun';
import type { ServerEvent } from '../shared/contracts.ts';
import { createApp } from './app.ts';
import { IrcManager } from './irc.ts';
import { PushNotifier, vapidKeys, webPushSender } from './push.ts';
import { Store } from './store.ts';

const host = process.env.LINGO_HOST ?? '127.0.0.1';
const port = Number(process.env.LINGO_PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('LINGO_PORT must be an integer between 1 and 65535');
}
const retentionValue = process.env.LINGO_HISTORY_RETENTION_DAYS;
const globalRetentionDays = retentionValue === undefined ? null : Number(retentionValue);
if (globalRetentionDays !== null && (!Number.isInteger(globalRetentionDays) || globalRetentionDays < 1 || globalRetentionDays > 3650)) {
  throw new Error('LINGO_HISTORY_RETENTION_DAYS must be an integer between 1 and 3650');
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
const vapid = vapidKeys(store);
// Push services contact the VAPID subject about misbehaving senders; the public origin identifies this server.
const push = new PushNotifier(store, vapid.publicKey, webPushSender(vapid, publicOrigin ?? 'mailto:lingo@localhost'));
const manager = new IrcManager(store, (event) => publish(event), push);
const setupToken = store.setupRequired() ? randomBytes(24).toString('base64url') : undefined;
const service = createApp(store, manager, {
  publicOrigin,
  setupToken,
  trustProxy: process.env.LINGO_TRUST_PROXY === '1',
  push,
});
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

let housekeepingJob: Promise<void> | null = null;
function housekeeping(): Promise<void> {
  if (housekeepingJob) return housekeepingJob;
  store.pruneSessions(Date.now());
  const job = store.pruneHistory(Date.now(), globalRetentionDays);
  housekeepingJob = job;
  void job.finally(() => { housekeepingJob = null; }).catch(() => {});
  return job;
}

try {
  manager.start();
  await housekeeping();
} catch (error) {
  server.stop(true);
  manager.stop();
  store.close();
  throw error;
}

const housekeepingTimer = setInterval(() => {
  void housekeeping().catch(error => console.error('Housekeeping failed:', error));
}, 60 * 60 * 1000);

console.log(`Lingo listening on ${server.url}`);
if (setupToken) console.log(`Lingo setup: open ${publicOrigin ?? server.url}?setup=${setupToken}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(housekeepingTimer);
  manager.stop();
  server.stop(true);
  try {
    await housekeepingJob;
  } finally {
    store.close();
    process.exit(0);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
