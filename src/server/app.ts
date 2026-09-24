import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Hono, type Context } from 'hono';
import { getConnInfo, upgradeWebSocket, websocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import type {
  AccountUser, Bootstrap, ChatBuffer, MentionCandidate, PushKey, ServerEvent, SetupStatus,
} from '../shared/contracts.ts';
import type { IrcManager } from './irc.ts';
import { RateLimiter } from './limits.ts';
import type { PushNotifier } from './push.ts';
import { NetworkLimitReached, type Store } from './store.ts';

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
const newPassword = z.string().min(8).max(1024);
const loginInput = z.strictObject({ username: z.string().max(64), password: z.string().max(1024) });
const accountInput = z.strictObject({
  username: z.string().min(1).max(32).regex(/^[A-Za-z0-9_.-]+$/, 'Invalid username'),
  password: newPassword,
});
const setupInput = accountInput.extend({ token: z.string().optional() });
const passwordInput = z.strictObject({ currentPassword: z.string().max(1024), newPassword });
const resetPasswordInput = z.strictObject({ password: newPassword });
const userUpdateInput = z.strictObject({
  disabled: z.boolean().optional(),
  maxNetworks: z.number().int().min(0).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
}).refine(value => Object.values(value).some(field => field !== undefined));
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
const readInput = z.strictObject({ messageId: z.number().int().positive().safe() });
const nickInput = z.strictObject({ nick: required(64).regex(/^[^\s,:]+$/, 'Invalid nickname') });
const queryInput = z.strictObject({ networkId: z.number().int().positive(), nick: nickInput.shape.nick });
const channelListInput = z.strictObject({ mask: required(100).regex(/^[^\s,:]+$/, 'Invalid mask').optional() });
const settingsInput = z.strictObject({
  highlights: z.array(required(100)).max(100),
  mutedBuffers: z.array(z.number().int().positive().safe()).max(1000),
  mutedNetworks: z.array(z.number().int().positive().safe()).max(1000),
  hiddenBuffers: z.array(z.number().int().positive().safe()).max(1000),
  collapsedNetworks: z.array(z.number().int().positive().safe()).max(1000),
  pushIncludesText: z.boolean(),
  sendTyping: z.boolean(),
}).partial();
const base64UrlBytes = (bytes: number) => z.string().max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .refine(value => Buffer.from(value, 'base64url').length === bytes, 'Invalid key');
/** Push services are public HTTPS hosts; refusing loopback and IP literals keeps the sender off local services. */
const pushEndpoint = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && host !== 'localhost' &&
      !host.endsWith('.localhost') && !host.startsWith('[') && !/^[\d.]+$/.test(host);
  } catch {
    return false;
  }
}, 'Invalid push endpoint');
const pushSubscriptionInput = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: base64UrlBytes(65), auth: base64UrlBytes(16) }),
});
const pushEndpointInput = z.strictObject({ endpoint: pushEndpoint });
const PUSH_SUBSCRIPTION_LIMIT = 10;

const sendInput = z.strictObject({
  bufferId: z.number().int().positive(),
  text: line(4096).refine((text) => text.trim().length > 0, 'Message cannot be empty'),
});

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  return `scrypt:${salt.toString('hex')}:${(await scryptAsync(password, salt, 64)).toString('hex')}`;
}

async function verifyPassword(candidate: string, savedHash: string): Promise<boolean> {
  const parts = /^scrypt:([0-9a-f]{64}):([0-9a-f]{128})$/.exec(savedHash);
  if (!parts) throw new Error('Invalid stored password hash');
  const actual = await scryptAsync(candidate, Buffer.from(parts[1]!, 'hex'), 64);
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

/** Hono context variables set by the session middleware for authenticated routes. */
export type AppEnv = { Variables: { user: AccountUser; session: string } };
type Client = { ws: WSContext; tokenHash: string; userId: number };

/** Routes reachable without a session: sign-in and first-login admin setup. */
const PUBLIC_ROUTES = new Set(['POST /api/login', 'GET /api/setup', 'POST /api/setup']);

export function createApp(
  store: Store,
  manager: IrcManager,
  options: {
    publicOrigin?: string; setupToken?: string; trustProxy?: boolean; now?: () => number; push?: PushNotifier;
  } = {},
) {
  const clients = new Map<unknown, Client>();
  const app = new Hono<AppEnv>();
  // Unknown usernames are checked against this hash so response time does not reveal which accounts exist.
  const unknownUserHash = hashPassword(randomBytes(32).toString('hex'));
  const loginUsers = new RateLimiter(10, 15 * 60_000);
  const loginIps = new RateLimiter(30, 15 * 60_000);
  const setupIps = new RateLimiter(10, 15 * 60_000);
  const passwordUsers = new RateLimiter(10, 15 * 60_000);
  const now = options.now ?? Date.now;

  function clientIp(c: Context): string {
    if (options.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
      if (forwarded) return `ip:${forwarded}`;
    }
    try {
      return `ip:${getConnInfo(c).remote.address || 'unknown'}`;
    } catch {
      return 'ip:unknown'; // app.request has no Bun server connection info.
    }
  }

  function limited(c: Context, checks: Array<{ allowed: boolean; retryAfterMs: number }>): Response | null {
    const wait = Math.max(0, ...checks.filter(result => !result.allowed).map(result => result.retryAfterMs));
    if (!wait) return null;
    c.header('Retry-After', String(Math.ceil(wait / 1000)));
    return c.json({ error: 'Too many attempts, try again later' }, 429);
  }

  function currentSession(c: Context): { hash: string; user: AccountUser } | null {
    const token = getCookie(c, COOKIE);
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const hash = hashToken(token);
    const user = store.sessionUser(hash, Date.now());
    return user ? { hash, user } : null;
  }

  function updatePresence(): void {
    manager.setBrowserPresence(new Set([...clients.values()].map(client => client.userId)));
  }

  function closeClients(matches: (client: Client) => boolean, reason: string): void {
    for (const [key, client] of clients) {
      if (!matches(client)) continue;
      if (client.ws.readyState < 2) client.ws.close(1008, reason);
      clients.delete(key);
    }
    updatePresence();
  }

  function secureCookie(c: Context): boolean {
    return new URL(options.publicOrigin ?? c.req.url).protocol === 'https:';
  }

  function startSession(c: Context, userId: number): void {
    const previous = currentSession(c);
    if (previous) {
      store.deleteSession(previous.hash, previous.user.id);
      closeClients(client => client.tokenHash === previous.hash, 'Session replaced');
    }
    const token = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    store.createSession(hashToken(token), userId, createdAt + SESSION_AGE_SECONDS * 1000, createdAt);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: secureCookie(c),
      path: '/',
      maxAge: SESSION_AGE_SECONDS,
    });
  }

  function eventOwner(event: ServerEvent): number | null {
    switch (event.type) {
      case 'message': return store.networkOwner(event.message.networkId);
      case 'buffer': return store.networkOwner(event.buffer.networkId);
      case 'buffer_removed':
      case 'read': return store.bufferOwner(event.bufferId);
      case 'history_cleared': return store.bufferOwner(event.bufferId);
      case 'network':
      case 'network_removed':
      case 'ignores': return store.networkOwner(event.networkId);
      case 'channel_state': return store.bufferOwner(event.state.bufferId);
      case 'channel_list': return store.networkOwner(event.status.networkId);
      case 'settings': return event.userId;
    }
  }

  /** Sends an event to its owner's browsers; removal events pass `userId` since the row is already gone. */
  function publish(event: ServerEvent, userId?: number): void {
    if (clients.size === 0) return;
    const owner = userId ?? eventOwner(event);
    if (owner === null) return;
    const message = JSON.stringify(event);
    const valid = new Map<string, boolean>();
    for (const [key, client] of clients) {
      if (client.userId !== owner) continue;
      let active = valid.get(client.tokenHash);
      if (active === undefined) {
        active = store.sessionUser(client.tokenHash, Date.now())?.id === owner;
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

  function adminUsers() {
    return store.listAdminUsers(Date.now()).map(user => ({
      ...user,
      connectedCount: Object.values(manager.status(user.id)).filter(status => status.state === 'connected').length,
    }));
  }

  function ownsNetwork(c: Context<AppEnv>, networkId: number): boolean {
    return store.networkOwner(networkId) === c.get('user').id;
  }

  function ownedBuffer(c: Context<AppEnv>, bufferId: number): ChatBuffer | null {
    return store.bufferOwner(bufferId) === c.get('user').id ? store.getBuffer(bufferId) : null;
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
      if (!sameOrigin(c, options.publicOrigin)) return c.json({ error: 'Forbidden origin' }, 403);
    }
    if (!PUBLIC_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
      const session = currentSession(c);
      if (!session) return c.json({ error: 'Unauthorized' }, 401);
      if ((c.req.path === '/api/users' || c.req.path.startsWith('/api/users/')) && !session.user.isAdmin) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      c.set('user', session.user);
      c.set('session', session.hash);
    }
    await next();
  });

  app.get('/api/setup', (c) => c.json({ required: store.setupRequired() } satisfies SetupStatus));

  app.post('/api/setup', async (c) => {
    const { username, password, token } = await jsonBody(c, setupInput);
    if (!store.setupRequired()) return c.json({ error: 'Setup already completed' }, 409);
    const ip = clientIp(c);
    const time = now();
    const blocked = limited(c, [setupIps.check(ip, time)]);
    if (blocked) return blocked;
    setupIps.fail(ip, time);
    const supplied = createHash('sha256').update(token ?? '').digest();
    const expected = createHash('sha256').update(options.setupToken ?? '').digest();
    if (!options.setupToken || !timingSafeEqual(supplied, expected)) {
      return c.json({ error: 'Invalid setup token' }, 403);
    }
    const user = store.claimAdmin(username, await hashPassword(password));
    if (!user) return c.json({ error: 'Setup already completed' }, 409);
    startSession(c, user.id);
    return c.json({ ok: true });
  });

  app.post('/api/login', async (c) => {
    const { username, password } = await jsonBody(c, loginInput);
    if (store.setupRequired()) return c.json({ error: 'Setup required' }, 409);
    const userKey = `user:${username.toLowerCase()}`;
    const ip = clientIp(c);
    const time = now();
    const blocked = limited(c, [loginUsers.check(userKey, time), loginIps.check(ip, time)]);
    if (blocked) return blocked;
    const credentials = store.getCredentials(username);
    const valid = await verifyPassword(password, credentials?.passwordHash ?? await unknownUserHash);
    if (!credentials?.passwordHash || !valid) {
      loginUsers.fail(userKey, time);
      loginIps.fail(ip, time);
      return c.json({ error: 'Invalid username or password' }, 401);
    }
    loginUsers.reset(userKey);
    if (store.isUserDisabled(credentials.user.id)) return c.json({ error: 'Account disabled' }, 403);
    startSession(c, credentials.user.id);
    return c.json({ ok: true });
  });

  app.post('/api/logout', (c) => {
    const session = c.get('session');
    store.deleteSession(session, c.get('user').id);
    closeClients(client => client.tokenHash === session, 'Logged out');
    setCookie(c, COOKIE, '', {
      httpOnly: true,
      sameSite: 'Strict',
      secure: secureCookie(c),
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    });
    return c.json({ ok: true });
  });

  app.get('/api/account/sessions', (c) => {
    const current = c.get('session');
    return c.json({
      sessions: store.listSessions(c.get('user').id, Date.now()).map(session => ({
        ...session, current: session.id === current,
      })),
    });
  });

  app.delete('/api/account/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id)) throw new BadRequest();
    const userId = c.get('user').id;
    store.deleteSession(id, userId);
    closeClients(client => client.tokenHash === id && client.userId === userId, 'Session revoked');
    return c.json({ ok: true });
  });

  app.post('/api/account/password', async (c) => {
    const { currentPassword, newPassword: password } = await jsonBody(c, passwordInput);
    const userId = c.get('user').id;
    const key = `uid:${userId}`;
    const time = now();
    const blocked = limited(c, [passwordUsers.check(key, time)]);
    if (blocked) return blocked;
    const saved = store.getPasswordHash(userId);
    if (!saved || !await verifyPassword(currentPassword, saved)) {
      passwordUsers.fail(key, time);
      return c.json({ error: 'Invalid password' }, 401);
    }
    passwordUsers.reset(key);
    const current = c.get('session');
    store.setPassword(userId, await hashPassword(password), current);
    closeClients(client => client.userId === userId && client.tokenHash !== current, 'Password changed');
    return c.json({ ok: true });
  });

  app.get('/api/users', (c) => c.json({ users: adminUsers() }));

  app.post('/api/users', async (c) => {
    const { username, password } = await jsonBody(c, accountInput);
    const user = store.createUser(username, await hashPassword(password));
    if (!user) return c.json({ error: 'Username already exists' }, 409);
    return c.json(user, 201);
  });

  app.patch('/api/users/:id', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { disabled, maxNetworks, retentionDays } = await jsonBody(c, userUpdateInput);
    const target = store.getUser(id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    if (disabled !== undefined && target.isAdmin) return c.json({ error: 'Cannot disable admin account' }, 400);
    if (maxNetworks !== undefined || retentionDays !== undefined) {
      store.setUserLimits(id, { maxNetworks, retentionDays });
    }
    if (disabled !== undefined && store.isUserDisabled(id) !== disabled) {
      store.setUserDisabled(id, disabled);
      if (disabled) {
        closeClients(client => client.userId === id, 'Account disabled');
        for (const network of store.listNetworks(id)) manager.disconnect(network.id);
      } else {
        for (const network of store.listNetworks(id)) {
          if (!store.isNetworkDisconnected(network.id)) manager.connect(network);
        }
      }
    }
    return c.json(adminUsers().find(user => user.id === id)!);
  });

  app.post('/api/users/:id/password', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { password } = await jsonBody(c, resetPasswordInput);
    const target = store.getUser(id);
    if (!target || target.isAdmin) return c.json({ error: 'User not found' }, 404);
    store.setPassword(id, await hashPassword(password), null);
    closeClients(client => client.userId === id, 'Password reset');
    return c.json({ ok: true });
  });

  app.delete('/api/users/:id', (c) => {
    const id = integer(c.req.param('id'))!;
    const target = store.getUser(id);
    if (!target || target.isAdmin) return c.json({ error: 'User not found' }, 404);
    closeClients(client => client.userId === id, 'Account deleted');
    for (const network of store.listNetworks(id)) {
      manager.disconnect(network.id);
      manager.forgetNetwork(network.id);
    }
    for (const buffer of store.listBuffers(id)) manager.forgetBuffer(buffer.id);
    store.removeUser(id);
    return c.json({ ok: true });
  });

  app.get('/api/settings/away', (c) => c.json({ message: store.getAwayMessage(c.get('user').id) }));

  app.patch('/api/settings/away', async (c) => {
    const { message } = await jsonBody(c, awayInput);
    const userId = c.get('user').id;
    store.setAwayMessage(userId, message);
    manager.updateAwayMessage(userId);
    return c.json({ message });
  });

  app.get('/api/settings', (c) => c.json(store.getSettingsState(c.get('user').id).settings));

  app.patch('/api/settings', async (c) => {
    const patch = await jsonBody(c, settingsInput);
    const userId = c.get('user').id;
    for (const id of [...(patch.mutedNetworks ?? []), ...(patch.collapsedNetworks ?? [])]) {
      if (store.networkOwner(id) !== userId) return c.json({ error: 'Network not found' }, 404);
    }
    for (const id of [...(patch.mutedBuffers ?? []), ...(patch.hiddenBuffers ?? [])]) {
      if (store.bufferOwner(id) !== userId) return c.json({ error: 'Buffer not found' }, 404);
    }
    const settings = store.patchSettings(userId, patch);
    publish({ type: 'settings', userId, settings });
    return c.json(settings);
  });

  app.get('/api/push/key', (c) => {
    if (!options.push) return c.json({ error: 'Push is not available' }, 503);
    return c.json({ publicKey: options.push.publicKey } satisfies PushKey);
  });

  app.post('/api/push/subscriptions', async (c) => {
    const { endpoint, keys } = await jsonBody(c, pushSubscriptionInput);
    if (!options.push) return c.json({ error: 'Push is not available' }, 503);
    const saved = store.savePushSubscription(c.get('user').id, c.get('session'),
      { endpoint, p256dh: keys.p256dh, auth: keys.auth }, PUSH_SUBSCRIPTION_LIMIT, Date.now());
    if (!saved) return c.json({ error: 'Too many push devices; disable push on another device first' }, 409);
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/push/subscriptions', async (c) => {
    const { endpoint } = await jsonBody(c, pushEndpointInput);
    store.deletePushSubscription(c.get('user').id, endpoint);
    return c.json({ ok: true });
  });

  app.post('/api/push/test', async (c) => {
    if (!options.push) return c.json({ error: 'Push is not available' }, 503);
    const delivered = await options.push.deliver(c.get('user').id,
      { bufferId: null, title: 'Lingo', body: 'Test notification' });
    if (!delivered) return c.json({ error: 'No device accepted the notification' }, 502);
    return c.json({ delivered });
  });

  app.get('/api/bootstrap', (c) => {
    const user = c.get('user');
    const { settings, configured } = store.getSettingsState(user.id);
    return c.json({
      user,
      settings,
      settingsConfigured: configured,
      networks: store.listNetworks(user.id),
      buffers: store.listBuffers(user.id),
      statuses: manager.status(user.id),
      ignores: store.allIgnores(user.id),
      unread: store.getUnread(user.id),
    } satisfies Bootstrap);
  });

  app.post('/api/networks', async (c) => {
    const input = normalizedNetworkInput(await jsonBody(c, networkInput));
    let network;
    try {
      network = store.createNetwork(c.get('user').id, input);
    } catch (error) {
      if (error instanceof NetworkLimitReached) return c.json({ error: 'Network limit reached' }, 409);
      throw error;
    }
    manager.connect(network);
    return c.json(network, 201);
  });

  app.patch('/api/networks/:id', async (c) => {
    const id = integer(c.req.param('id'))!;
    const input = normalizedNetworkInput(await jsonBody(c, networkInput));
    if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
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
      publish({ type: 'network', networkId: id, status: manager.status(c.get('user').id)[id]! });
    }
    return c.json(network);
  });

  app.delete('/api/networks/:id', (c) => {
    const id = integer(c.req.param('id'))!;
    if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
    manager.disconnect(id);
    manager.forgetNetwork(id);
    store.removeNetwork(id);
    publish({ type: 'network_removed', networkId: id }, c.get('user').id);
    return c.json({ ok: true });
  });

  for (const [action, connected] of [['connect', true], ['disconnect', false]] as const) {
    app.post(`/api/networks/:id/${action}`, (c) => {
      const id = integer(c.req.param('id'))!;
      if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
      manager.setConnected(id, connected);
      return c.json({ ok: true });
    });
  }

  app.get('/api/networks/:id/channels', (c) => {
    const id = integer(c.req.param('id'))!;
    if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
    const query = c.req.query('q') ?? '';
    if (query.length > 100) throw new BadRequest();
    const limit = integer(c.req.query('limit'), 1000) ?? 200;
    return c.json(manager.channelList(id, query, limit, c.req.query('names') === '1'));
  });

  app.post('/api/networks/:id/channels/refresh', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { mask } = await jsonBody(c, channelListInput);
    if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
    try {
      manager.requestChannelList(id, mask);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot list channels' }, 400);
    }
    return c.json({ ok: true });
  });

  app.post('/api/networks/:id/whois', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { nick } = await jsonBody(c, nickInput);
    if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
    try {
      return c.json(await manager.whois(id, nick));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot look up user' }, 400);
    }
  });

  for (const [method, ignored] of [['post', true], ['delete', false]] as const) {
    app[method]('/api/networks/:id/ignores', async (c) => {
      const id = integer(c.req.param('id'))!;
      const { nick } = await jsonBody(c, nickInput);
      if (!ownsNetwork(c, id)) return c.json({ error: 'Network not found' }, 404);
      return c.json({ ignores: manager.setIgnored(id, nick, ignored) });
    });
  }

  app.post('/api/buffers/query', async (c) => {
    const { networkId, nick } = await jsonBody(c, queryInput);
    if (!ownsNetwork(c, networkId)) return c.json({ error: 'Network not found' }, 404);
    try {
      return c.json(manager.openQuery(networkId, nick), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot open conversation' }, 400);
    }
  });

  app.post('/api/buffers/:id/bans', async (c) => {
    const id = integer(c.req.param('id'))!;
    const buffer = ownedBuffer(c, id);
    if (!buffer || buffer.kind !== 'channel') return c.json({ error: 'Channel not found' }, 404);
    try {
      return c.json({ bans: await manager.banList(id) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot list bans' }, 400);
    }
  });

  app.delete('/api/buffers/:id/messages', (c) => {
    const id = integer(c.req.param('id'))!;
    if (!ownedBuffer(c, id)) return c.json({ error: 'Buffer not found' }, 404);
    store.clearMessages(id);
    publish({ type: 'history_cleared', bufferId: id });
    return c.json({ ok: true });
  });

  app.post('/api/buffers', async (c) => {
    const { networkId, name } = await jsonBody(c, bufferInput);
    if (!ownsNetwork(c, networkId)) return c.json({ error: 'Network not found' }, 404);
    try {
      manager.join(networkId, name);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot join channel' }, 400);
    }
    return c.json(store.getOrCreateBuffer(networkId, name, 'channel'), 201);
  });
  app.post('/api/buffers/batch', async (c) => {
    const { networkId, names } = await jsonBody(c, batchBufferInput);
    if (!ownsNetwork(c, networkId)) return c.json({ error: 'Network not found' }, 404);
    try {
      return c.json({ buffers: manager.joinMany(networkId, names) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot join channels' }, 400);
    }
  });

  app.get('/api/buffers/:id/channel', (c) => {
    const id = integer(c.req.param('id'))!;
    const buffer = ownedBuffer(c, id);
    if (!buffer || buffer.kind !== 'channel') return c.json({ error: 'Channel not found' }, 404);
    return c.json(manager.channelState(id));
  });

  app.patch('/api/buffers/:id/topic', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { topic } = await jsonBody(c, topicInput);
    const buffer = ownedBuffer(c, id);
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
    const buffer = ownedBuffer(c, id);
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
    const buffer = ownedBuffer(c, id);
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
      publish({ type: 'buffer_removed', bufferId: id }, c.get('user').id);
    }
    return c.json({ ok: true });
  });

  app.post('/api/send', async (c) => {
    const { bufferId, text } = await jsonBody(c, sendInput);
    if (!ownedBuffer(c, bufferId)) return c.json({ error: 'Buffer not found' }, 404);
    try {
      manager.send(bufferId, text);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Cannot send message' }, 400);
    }
    return c.json({ ok: true });
  });

  app.put('/api/buffers/:id/read', async (c) => {
    const id = integer(c.req.param('id'))!;
    const { messageId } = await jsonBody(c, readInput);
    if (!ownedBuffer(c, id)) return c.json({ error: 'Buffer not found' }, 404);
    const lastReadId = store.markRead(id, messageId);
    if (lastReadId === null) return c.json({ error: 'Message not found' }, 404);
    publish({ type: 'read', bufferId: id, lastReadId });
    return c.json({ bufferId: id, lastReadId });
  });

  app.get('/api/messages', (c) => {
    const bufferId = integer(c.req.query('bufferId'));
    if (bufferId === undefined) throw new BadRequest();
    if (!ownedBuffer(c, bufferId)) return c.json({ error: 'Buffer not found' }, 404);
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
    if (networkId !== undefined && !ownsNetwork(c, networkId)) {
      return c.json({ error: 'Network not found' }, 404);
    }
    if (bufferId !== undefined && !ownedBuffer(c, bufferId)) {
      return c.json({ error: 'Buffer not found' }, 404);
    }
    return c.json(store.searchMessages(query, { userId: c.get('user').id, networkId, bufferId, before, limit, since, until }));
  });

  app.get('/api/events', (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'WebSocket upgrade required' }, 400);
    }
    const tokenHash = c.get('session');
    const userId = c.get('user').id;
    return upgradeWebSocket(c, {
      onOpen(_event, ws) {
        if (store.sessionUser(tokenHash, Date.now())?.id !== userId) {
          ws.close(1008, 'Session expired');
          return;
        }
        clients.set(ws.raw, { ws, tokenHash, userId });
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
