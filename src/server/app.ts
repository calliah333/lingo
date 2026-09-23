import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import type { MentionCandidate, ServerEvent } from '../shared/contracts.ts';
import type { IrcManager } from './irc.ts';
import type { Store } from './store.ts';

const COOKIE = 'lingo_session';
const SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[1-9]\d*$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;

const line = (maximum: number) => z.string().max(maximum).regex(/^[^\r\n\0]*$/, 'Must be one line');
const required = (maximum: number) => line(maximum).trim().min(1);
const networkInput = z.strictObject({
  name: required(100),
  host: required(255).regex(/^\S+$/, 'Must not contain spaces'),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
  nick: required(64).regex(/^\S+$/, 'Must not contain spaces'),
  username: line(64).trim().regex(/^\S*$/, 'Must not contain spaces'),
  realname: line(255).trim(),
  saslAccount: line(128).trim(),
  saslPassword: line(1024).optional(),
  autojoin: z.array(required(100).regex(/^[#&+!][^\s,\x00-\x1f\x7f]+$/, 'Invalid channel')).max(100),
  commands: z.array(required(512)).max(50),
  relayNicks: z.array(required(64)).max(20).default([]),
  mentionAliases: z.array(required(64)).max(20).default([]),
  displayNames: z.record(required(64), required(64))
    .refine(names => Object.keys(names).length <= 100, 'Too many display names').default({}),
});
const loginInput = z.strictObject({ password: z.string().max(1024) });
const passwordInput = z.strictObject({
  currentPassword: z.string().max(1024),
  newPassword: z.string().min(8).max(1024),
});
const awayInput = z.strictObject({
  message: line(300).refine(value => Buffer.byteLength(value, 'utf8') <= 300, 'Message too long'),
});
const bufferInput = z.strictObject({
  networkId: z.number().int().positive(),
  name: required(100).regex(/^[#&+!][^\s,\x00-\x1f\x7f]+$/, 'Invalid channel'),
});
const batchBufferInput = z.strictObject({
  networkId: z.number().int().positive(),
  names: z.array(bufferInput.shape.name).min(1).max(20)
    .refine(names => new Set(names.map(name => name.toLowerCase())).size === names.length,
      'Duplicate channels'),
});
const topicInput = z.strictObject({ topic: line(390) });

const sendInput = z.strictObject({
  bufferId: z.number().int().positive(),
  text: line(4096).refine((text) => text.trim().length > 0, 'Message cannot be empty'),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function passwordHash(password: string): string {
  const salt = randomBytes(32);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(candidate: string, savedHash: string | null, legacyDigest: Buffer): boolean {
  if (!savedHash) {
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), legacyDigest);
  }
  const parts = /^scrypt:([0-9a-f]{64}):([0-9a-f]{128})$/.exec(savedHash);
  if (!parts) throw new Error('Invalid stored password hash');
  const actual = scryptSync(candidate, Buffer.from(parts[1]!, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(parts[2]!, 'hex'));
}
function integer(value: string | undefined, cap?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!ID_PATTERN.test(value)) throw new BadRequest();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new BadRequest();
  return cap === undefined ? number : Math.min(number, cap);
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequest();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new BadRequest();
  return number;
}

class BadRequest extends Error {}

async function jsonBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequest();
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequest();
  return parsed.data;
}

function sameOrigin(c: Context, publicOrigin?: string): boolean {
  const host = c.req.header('host');
  if (!host) return false;
  let request: URL;
  let expected: URL;
  try {
    request = new URL(c.req.url);
    expected = new URL(`${request.protocol}//${host}`);
    if (expected.username || expected.password || expected.pathname !== '/' ||
      expected.search || expected.hash || !expected.hostname) return false;
  } catch {
    return false;
  }
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const source = new URL(origin);
      return source.origin === origin && source.origin === (publicOrigin ?? expected.origin);
    } catch {
      return false;
    }
  }
  // CLI clients commonly omit Origin. Browsers supply it for mutations and upgrades;
  // their Fetch Metadata header still lets us reject cross-site origin-less requests.
  const fetchSite = c.req.header('sec-fetch-site');
  return (!fetchSite || fetchSite === 'same-origin') && request.host === expected.host;
}

function normalizedNetworkInput(input: z.output<typeof networkInput>): z.output<typeof networkInput> {
  return {
    ...input,
    username: input.username || input.nick,
    realname: input.realname || input.nick,
  };
}

export function createApp(store: Store, manager: IrcManager, password: string, publicOrigin?: string) {
  if (!password) throw new Error('LINGO_PASSWORD must be set');
  const passwordDigest = createHash('sha256').update(password).digest();
  const clients = new Map<unknown, { ws: WSContext; tokenHash: string }>();
  const app = new Hono();


  function sessionHash(c: Context): string | null {
    const token = getCookie(c, COOKIE);
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const digest = hashToken(token);
    return store.hasSession(digest, Date.now()) ? digest : null;
  }
  function updatePresence(): void {
    manager.setBrowserPresence(clients.size > 0);
  }

  function closeSessionClients(digest: string, reason: string): void {
    for (const [key, client] of clients) {
      if (client.tokenHash !== digest) continue;
      if (client.ws.readyState < 2) client.ws.close(1008, reason);
      clients.delete(key);
    }
    updatePresence();
  }


  function publish(event: ServerEvent): void {
    if (clients.size === 0) return;
    const message = JSON.stringify(event);
    const valid = new Map<string, boolean>();
    for (const [key, client] of clients) {
      let active = valid.get(client.tokenHash);
      if (active === undefined) {
        active = store.hasSession(client.tokenHash, Date.now());
        valid.set(client.tokenHash, active);
      }
      if (!active || client.ws.readyState !== 1) {
        if (client.ws.readyState < 2) client.ws.close(1008, 'Session expired');
        clients.delete(key);
      } else {
        try {
          client.ws.send(message);
        } catch {
          clients.delete(key);
        }
      }
    }
    updatePresence();
  }

  app.onError((error, c) => {
    if (error instanceof BadRequest) return c.json({ error: 'Invalid request' }, 400);
    // A duplicate network name is an input conflict, not an internal failure.
    if ('code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return c.json({ error: 'Network name already exists' }, 400);
    }
    console.error('Request failed:', error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.use('/api/*', async (c, next) => {
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || c.req.path === '/api/events') {
      if (!sameOrigin(c, publicOrigin)) return c.json({ error: 'Forbidden origin' }, 403);
    }
    if (!(c.req.path === '/api/login' && c.req.method === 'POST') && !sessionHash(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/api/login', async (c) => {
    const { password: candidate } = await jsonBody(c, loginInput);
    if (!verifyPassword(candidate, store.getPasswordHash(), passwordDigest)) {
      return c.json({ error: 'Invalid password' }, 401);
    }
    const oldToken = getCookie(c, COOKIE);
    if (oldToken && TOKEN_PATTERN.test(oldToken)) {
      const previous = hashToken(oldToken);
      store.deleteSession(previous);
      closeSessionClients(previous, 'Session replaced');
    }
    const token = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    store.createSession(hashToken(token), createdAt + SESSION_AGE_SECONDS * 1000, createdAt);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: publicOrigin ? new URL(publicOrigin).protocol === 'https:' : new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: SESSION_AGE_SECONDS,
    });
    return c.json({ ok: true });
  });

  app.post('/api/logout', (c) => {
    const digest = sessionHash(c)!;
    store.deleteSession(digest);
    closeSessionClients(digest, 'Logged out');
    setCookie(c, COOKIE, '', {
      httpOnly: true,
      sameSite: 'Strict',
      secure: publicOrigin ? new URL(publicOrigin).protocol === 'https:' : new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    });
    return c.json({ ok: true });
  });
  app.get('/api/account/sessions', (c) => {
    const current = sessionHash(c)!;
    return c.json({
      sessions: store.listSessions(Date.now()).map(session => ({
        ...session, current: session.id === current,
      })),
    });
  });

  app.delete('/api/account/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id)) throw new BadRequest();
    store.deleteSession(id);
    closeSessionClients(id, 'Session revoked');
    return c.json({ ok: true });
  });

  app.post('/api/account/password', async (c) => {
    const { currentPassword, newPassword } = await jsonBody(c, passwordInput);
    if (!verifyPassword(currentPassword, store.getPasswordHash(), passwordDigest)) {
      return c.json({ error: 'Invalid password' }, 401);
    }
    const current = sessionHash(c)!;
    store.revokeOtherSessions(current, passwordHash(newPassword));
    for (const client of new Set([...clients.values()].map(value => value.tokenHash))) {
      if (client !== current) closeSessionClients(client, 'Password changed');
    }
    return c.json({ ok: true });
  });

  app.get('/api/settings/away', (c) => c.json({ message: store.getAwayMessage() }));

  app.patch('/api/settings/away', async (c) => {
    const { message } = await jsonBody(c, awayInput);
    store.setAwayMessage(message);
    manager.updateAwayMessage();
    return c.json({ message });
  });


  app.get('/api/bootstrap', (c) => c.json({
    networks: store.listNetworks(),
    buffers: store.listBuffers(),
    statuses: manager.status(),
  }));

  app.post('/api/networks', async (c) => {
    const input = normalizedNetworkInput(await jsonBody(c, networkInput));
    const network = store.createNetwork(input);
    manager.connect(network);
    return c.json(network, 201);
  });

  app.patch('/api/networks/:id', async (c) => {
    const id = integer(c.req.param('id'))!;
    const input = normalizedNetworkInput(await jsonBody(c, networkInput));
    const existing = store.getNetworkConfig(id);
    const network = store.updateNetwork(id, input);
    if (!network) return c.json({ error: 'Network not found' }, 404);

    const saslPassword = input.saslPassword?.trim() ? input.saslPassword : existing?.saslPassword;
    const reconnect = !existing ||
      existing.name !== network.name ||
      existing.host !== network.host ||
      existing.port !== network.port ||
      existing.tls !== network.tls ||
      existing.nick !== network.nick ||
      existing.username !== network.username ||
      existing.realname !== network.realname ||
      existing.saslAccount !== network.saslAccount ||
      existing.saslPassword !== saslPassword ||
      JSON.stringify(existing.autojoin) !== JSON.stringify(network.autojoin) ||
      JSON.stringify(existing.commands) !== JSON.stringify(network.commands);

    if (reconnect) {
      manager.update(network);
    } else {
      publish({ type: 'network', networkId: id, status: manager.status()[id] });
    }
    return c.json(network);
  });

  app.delete('/api/networks/:id', (c) => {
    const id = integer(c.req.param('id'))!;
    if (!store.getNetwork(id)) return c.json({ error: 'Network not found' }, 404);
    manager.disconnect(id);
    store.removeNetwork(id);
    publish({ type: 'network_removed', networkId: id });
    return c.json({ ok: true });
  });

  app.post('/api/buffers', async (c) => {
    const { networkId, name } = await jsonBody(c, bufferInput);
    if (!store.getNetwork(networkId)) return c.json({ error: 'Network not found' }, 404);
    try {
      manager.join(networkId, name);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot join channel' }, 400);
    }
    return c.json(store.getOrCreateBuffer(networkId, name, 'channel'), 201);
  });
  app.post('/api/buffers/batch', async (c) => {
    const { networkId, names } = await jsonBody(c, batchBufferInput);
    if (!store.getNetwork(networkId)) return c.json({ error: 'Network not found' }, 404);
    try {
      return c.json({ buffers: manager.joinMany(networkId, names) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot join channels' }, 400);
    }
  });

  app.get('/api/buffers/:id/channel', (c) => {
    const id = integer(c.req.param('id'))!;
    const buffer = store.getBuffer(id);
    if (!buffer || buffer.kind !== 'channel') return c.json({ error: 'Channel not found' }, 404);
    return c.json(manager.channelState(id));
  });

  app.patch('/api/buffers/:id/topic', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { topic } = await jsonBody(c, topicInput);
    const buffer = store.getBuffer(id);
    if (!buffer || buffer.kind !== 'channel') return c.json({ error: 'Channel not found' }, 404);
    try {
      manager.setTopic(id, topic);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot set topic' }, 400);
    }
    return c.json({ ok: true });
  });


  app.get('/api/buffers/:id/participants', (c) => {
    const id = integer(c.req.param('id'))!;
    const buffer = store.getBuffer(id);
    if (!buffer) return c.json({ error: 'Buffer not found' }, 404);
    const seen = new Set<string>();
    const participants: MentionCandidate[] = [];
    for (const candidate of [...manager.listLiveParticipants(id), ...store.listRecentParticipants(id)]) {
      const mention = candidate.mention.trim();
      if (!mention) continue;
      const key = mention.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push({ name: candidate.name, mention });
      if (participants.length === 100) break;
    }
    return c.json({ participants });
  });

  app.delete('/api/buffers/:id', (c) => {
    const id = integer(c.req.param('id'))!;
    const buffer = store.getBuffer(id);
    if (!buffer) return c.json({ error: 'Buffer not found' }, 404);
    if (buffer.kind === 'channel') {
      try {
        manager.part(id);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Cannot leave channel' }, 400);
      }
    } else {
      manager.forgetBuffer(id);
      store.removeBuffer(id);
      publish({ type: 'buffer_removed', bufferId: id });
    }
    return c.json({ ok: true });
  });

  app.post('/api/send', async (c) => {
    const { bufferId, text } = await jsonBody(c, sendInput);
    if (!store.getBuffer(bufferId)) return c.json({ error: 'Buffer not found' }, 404);
    try {
      manager.send(bufferId, text);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot send message' }, 400);
    }
    return c.json({ ok: true });
  });

  app.get('/api/messages', (c) => {
    const bufferId = integer(c.req.query('bufferId'));
    if (bufferId === undefined) throw new BadRequest();
    if (!store.getBuffer(bufferId)) return c.json({ error: 'Buffer not found' }, 404);
    const before = integer(c.req.query('before'));
    const limit = integer(c.req.query('limit'), 100);
    return c.json(store.getMessages(bufferId, before, limit));
  });

  app.get('/api/search', (c) => {
    const query = c.req.query('q')?.replaceAll('\0', ' ').trim();
    if (!query || query.length > 256) throw new BadRequest();
    const networkId = integer(c.req.query('networkId'));
    const bufferId = integer(c.req.query('bufferId'));
    const before = integer(c.req.query('before'));
    const limit = integer(c.req.query('limit'), 100);
    const since = timestamp(c.req.query('since'));
    const until = timestamp(c.req.query('until'));
    if (since !== undefined && until !== undefined && since > until) throw new BadRequest();
    if (networkId !== undefined && !store.getNetwork(networkId)) {
      return c.json({ error: 'Network not found' }, 404);
    }
    if (bufferId !== undefined && !store.getBuffer(bufferId)) {
      return c.json({ error: 'Buffer not found' }, 404);
    }
    return c.json(store.searchMessages(query, { networkId, bufferId, before, limit, since, until }));
  });

  app.get('/api/events', (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'WebSocket upgrade required' }, 400);
    }
    const tokenHash = sessionHash(c)!;
    return upgradeWebSocket(c, {
      onOpen(_event, ws) {
        if (!store.hasSession(tokenHash, Date.now())) {
          ws.close(1008, 'Session expired');
          return;
        }
        clients.set(ws.raw, { ws, tokenHash });
        updatePresence();
      },
      onClose(_event, ws) {
        clients.delete(ws.raw);
        updatePresence();
      },
    });
  });

  return { app, websocket, publish };
}
