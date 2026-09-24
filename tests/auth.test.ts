import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { IrcManager } from '../src/server/irc.ts';
import { RateLimiter } from '../src/server/limits.ts';
import { Store } from '../src/server/store.ts';

const HOST = 'lingo.test';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'root', password: PASSWORD };
const SETUP_TOKEN = 'test-setup-token';
const SETUP = { ...ADMIN, token: SETUP_TOKEN };

type App = Hono<AppEnv>;

function request(
  app: App,
  path: string,
  options: { method?: string; origin?: string; cookie?: string; body?: unknown; forwardedFor?: string } = {},
): Promise<Response> {
  const headers = new Headers({ host: HOST, origin: options.origin ?? ORIGIN });
  if (options.forwardedFor) headers.set('x-forwarded-for', options.forwardedFor);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return Promise.resolve(app.request(`http://${HOST}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

function cookieFrom(response: Response): string {
  expect(response.status).toBe(200);
  const token = response.headers.get('set-cookie')?.match(/(?:^|,\s*)lingo_session=([^;,\s]+)/)?.[1];
  expect(token).toBeTruthy();
  return `lingo_session=${token}`;
}

const login = (app: App, username: string, password: string) =>
  request(app, '/api/login', { method: 'POST', body: { username, password } });

test('fixed-window limits expire, reset, and evict old keys', () => {
  const limiter = new RateLimiter(2, 1000, 2);
  limiter.fail('first', 0);
  limiter.fail('first', 1);
  expect(limiter.check('first', 2)).toEqual({ allowed: false, retryAfterMs: 998 });
  limiter.fail('second', 2);
  limiter.fail('third', 2);
  expect(limiter.check('first', 2).allowed).toBe(true);
  limiter.fail('third', 3);
  limiter.reset('third');
  expect(limiter.check('third', 3).allowed).toBe(true);
  limiter.fail('second', 3);
  expect(limiter.check('second', 1002).allowed).toBe(true);
});

test('limits password guesses before checking valid credentials', async () => {
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => {});
  let time = 1000;
  try {
    const app = createApp(store, manager, { setupToken: SETUP_TOKEN, now: () => time }).app;
    const cookie = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await login(app, attempt % 2 ? 'ROOT' : 'root', 'wrong')).status).toBe(401);
    }
    const blocked = await login(app, 'root', PASSWORD);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'Too many attempts, try again later' });
    expect(blocked.headers.get('retry-after')).toBe('900');
    expect((await login(app, 'root', PASSWORD)).status).toBe(429);
    expect((await login(app, 'someone-else', 'wrong')).status).toBe(401);
    time += 15 * 60_000;
    expect((await login(app, 'root', PASSWORD)).status).toBe(200);
    expect((await login(app, 'root', 'wrong')).status).toBe(401);
    expect((await login(app, 'root', PASSWORD)).status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await request(app, '/api/account/password', {
        method: 'POST', cookie, body: { currentPassword: 'wrong', newPassword: 'new password' },
      })).status).toBe(401);
    }
    const change = await request(app, '/api/account/password', {
      method: 'POST', cookie, body: { currentPassword: PASSWORD, newPassword: 'new password' },
    });
    expect(change.status).toBe(429);
    expect(change.headers.get('retry-after')).toBe('900');
    time += 15 * 60_000;
    expect((await request(app, '/api/account/password', {
      method: 'POST', cookie, body: { currentPassword: PASSWORD, newPassword: 'new password' },
    })).status).toBe(200);
  } finally {
    manager.stop();
    store.close();
  }
}, 20_000);

test('limits login guesses by the trusted right-most proxy address', async () => {
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => {});
  try {
    const app = createApp(store, manager, { setupToken: SETUP_TOKEN, trustProxy: true }).app;
    cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await request(app, '/api/login', {
        method: 'POST', forwardedFor: `spoof-${attempt}, trusted-proxy`,
        body: { username: `unknown-${attempt}`, password: 'wrong' },
      })).status).toBe(401);
    }
    expect((await request(app, '/api/login', {
      method: 'POST', forwardedFor: 'another-client, trusted-proxy', body: ADMIN,
    })).status).toBe(429);
    expect((await request(app, '/api/login', {
      method: 'POST', forwardedFor: 'another-client, other-proxy', body: ADMIN,
    })).status).toBe(200);
  } finally {
    manager.stop();
    store.close();
  }
}, 20_000);

test('wrong setup tokens consume the per-IP attempt limit', async () => {
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => {});
  let time = 1000;
  try {
    const app = createApp(store, manager, { setupToken: SETUP_TOKEN, now: () => time }).app;
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await request(app, '/api/setup', {
        method: 'POST', body: { ...ADMIN, token: `wrong-${attempt}` },
      })).status).toBe(403);
    }
    const blocked = await request(app, '/api/setup', { method: 'POST', body: SETUP });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('900');
    expect(await (await request(app, '/api/setup')).json()).toEqual({ required: true });
    time += 15 * 60_000;
    cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
  } finally {
    manager.stop();
    store.close();
  }
});

describe('session and origin authorization', () => {
  test('creates the admin on first login, enforces same-origin mutations, and revokes logout sessions', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;

      expect((await request(app, '/api/bootstrap')).status).toBe(401);
      expect(await (await request(app, '/api/setup')).json()).toEqual({ required: true });
      expect((await login(app, 'admin', PASSWORD)).status).toBe(409);
      expect((await request(app, '/api/setup', {
        method: 'POST', origin: 'http://attacker.test', body: ADMIN,
      })).status).toBe(403);
      expect((await request(app, '/api/setup', {
        method: 'POST', body: { username: 'root', password: 'short' },
      })).status).toBe(400);

      expect((await request(app, '/api/setup', { method: 'POST', body: ADMIN })).status).toBe(403);
      expect((await request(app, '/api/setup', {
        method: 'POST', body: { ...ADMIN, token: 'wrong' },
      })).status).toBe(403);
      expect(await (await request(app, '/api/setup')).json()).toEqual({ required: true });

      const setup = await request(app, '/api/setup', { method: 'POST', body: SETUP });
      const setupCookie = cookieFrom(setup);
      expect(await (await request(app, '/api/setup')).json()).toEqual({ required: false });
      // Setup can only happen once; a second claim must not replace the admin.
      expect((await request(app, '/api/setup', {
        method: 'POST', body: { username: 'intruder', password: 'another password' },
      })).status).toBe(409);
      expect((await login(app, 'intruder', 'another password')).status).toBe(401);
      const bootstrap = await (await request(app, '/api/bootstrap', { cookie: setupCookie })).json();
      expect(bootstrap.user).toMatchObject({ username: 'root', isAdmin: true });

      expect((await login(app, 'root', 'incorrect password')).status).toBe(401);
      expect((await login(app, 'nobody', PASSWORD)).status).toBe(401);
      expect((await request(app, '/api/login', {
        method: 'POST', origin: 'http://attacker.test', body: ADMIN,
      })).status).toBe(403);

      const response = await login(app, 'ROOT', PASSWORD);
      expect(await response.clone().text()).not.toContain(PASSWORD);
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      const cookie = cookieFrom(response);

      expect((await request(app, '/api/bootstrap', { cookie })).status).toBe(200);
      expect((await request(app, '/api/logout', {
        method: 'POST', origin: 'http://attacker.test', cookie,
      })).status).toBe(403);

      // A new app instance must recognize the persisted server-side session.
      const recreatedApp = createApp(store, manager).app;
      expect((await request(recreatedApp, '/api/bootstrap', { cookie })).status).toBe(200);
      expect((await request(recreatedApp, '/api/logout', { method: 'POST', cookie })).status).toBe(200);

      const proxiedApp = createApp(store, manager, { publicOrigin: 'https://irc.example.com' }).app;
      expect((await request(proxiedApp, '/api/login', {
        method: 'POST', origin: 'https://attacker.test', body: ADMIN,
      })).status).toBe(403);
      const proxiedLogin = await request(proxiedApp, '/api/login', {
        method: 'POST', origin: 'https://irc.example.com', body: ADMIN,
      });
      expect(proxiedLogin.status).toBe(200);
      expect(proxiedLogin.headers.get('set-cookie')).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
      expect((await request(app, '/api/bootstrap', { cookie })).status).toBe(401);
    } finally {
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('manages persisted account sessions and rotates the password', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingo-auth-'));
    const databasePath = join(directory, 'account.sqlite');
    let store = new Store(databasePath);
    let manager = new IrcManager(store, () => {});
    let storeOpen = true;
    let managerRunning = true;
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const cookieA = cookieFrom(await login(app, 'root', PASSWORD));
      const cookieB = cookieFrom(await login(app, 'root', PASSWORD));
      expect(cookieA).not.toBe(cookieB);

      const sessionsResponse = await request(app, '/api/account/sessions', { cookie: cookieA });
      expect(sessionsResponse.status).toBe(200);
      const sessions = (await sessionsResponse.json()).sessions as Array<{ id: string; current: boolean }>;
      expect(sessions).toHaveLength(3);
      expect(sessions.filter(session => session.current)).toHaveLength(1);
      const sessionB = createHash('sha256').update(cookieB.slice('lingo_session='.length)).digest('hex');
      expect(sessions.map(session => session.id)).toContain(sessionB);

      expect((await request(app, `/api/account/sessions/${sessionB}`, {
        method: 'DELETE', origin: 'http://attacker.test', cookie: cookieA,
      })).status).toBe(403);
      expect((await request(app, '/api/bootstrap', { cookie: cookieB })).status).toBe(200);
      expect((await request(app, `/api/account/sessions/${sessionB}`, { method: 'DELETE', cookie: cookieA })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: cookieB })).status).toBe(401);

      const cookieSecondB = cookieFrom(await login(app, 'root', PASSWORD));
      expect((await request(app, '/api/account/password', {
        method: 'POST',
        origin: 'http://attacker.test',
        cookie: cookieA,
        body: { currentPassword: PASSWORD, newPassword: 'new secure password' },
      })).status).toBe(403);
      expect((await request(app, '/api/account/password', {
        method: 'POST',
        cookie: cookieA,
        body: { currentPassword: 'wrong password', newPassword: 'new secure password' },
      })).status).toBe(401);
      expect((await login(app, 'root', PASSWORD)).status).toBe(200);

      expect((await request(app, '/api/account/password', {
        method: 'POST',
        cookie: cookieA,
        body: { currentPassword: PASSWORD, newPassword: 'new secure password' },
      })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: cookieA })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: cookieSecondB })).status).toBe(401);
      const remaining = (await (await request(app, '/api/account/sessions', {
        cookie: cookieA,
      })).json()).sessions as Array<{ current: boolean }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.current).toBe(true);

      manager.stop();
      managerRunning = false;
      storeOpen = false;
      store.close();
      store = new Store(databasePath);
      storeOpen = true;
      manager = new IrcManager(store, () => {});
      managerRunning = true;
      const reopenedApp = createApp(store, manager).app;
      expect((await request(reopenedApp, '/api/bootstrap', { cookie: cookieA })).status).toBe(200);
      expect((await login(reopenedApp, 'root', PASSWORD)).status).toBe(401);
      expect((await login(reopenedApp, 'root', 'new secure password')).status).toBe(200);
    } finally {
      if (managerRunning) manager.stop();
      if (storeOpen) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test('admin manages users whose networks, history, and sessions stay isolated', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      const admin = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const adminId = (await (await request(app, '/api/bootstrap', { cookie: admin })).json()).user.id as number;
      const network = store.createNetwork(adminId, {
        name: 'libera', host: 'irc.example.org', port: 6697, tls: true, nick: 'root', username: 'root',
        realname: 'Root', saslAccount: '', autojoin: [], commands: [], relayNicks: [], mentionAliases: [],
        displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      });
      const buffer = store.getOrCreateBuffer(network.id, '#secret', 'channel');
      store.appendMessage({ networkId: network.id, bufferId: buffer.id, kind: 'privmsg', nick: 'root', text: 'classified', time: 1 });

      const created = await request(app, '/api/users', {
        method: 'POST', cookie: admin, body: { username: 'alice', password: 'alice password' },
      });
      expect(created.status).toBe(201);
      const alice = await created.json();
      expect(alice).toMatchObject({ username: 'alice', isAdmin: false });
      expect((await request(app, '/api/users', {
        method: 'POST', cookie: admin, body: { username: 'ALICE', password: 'other password' },
      })).status).toBe(409);
      expect((await request(app, '/api/users', {
        method: 'POST', cookie: admin, body: { username: 'bad name', password: 'other password' },
      })).status).toBe(400);

      const aliceCookie = cookieFrom(await login(app, 'alice', 'alice password'));
      const aliceBootstrap = await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json();
      expect(aliceBootstrap).toMatchObject({ user: { username: 'alice', isAdmin: false }, networks: [], buffers: [] });

      // Non-admins cannot manage accounts or reach another user's networks, buffers, or history.
      expect((await request(app, '/api/users', { cookie: aliceCookie })).status).toBe(403);
      expect((await request(app, `/api/users/${adminId}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(403);
      expect((await request(app, `/api/messages?bufferId=${buffer.id}`, { cookie: aliceCookie })).status).toBe(404);
      expect((await request(app, `/api/networks/${network.id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
      expect((await request(app, `/api/buffers/${buffer.id}/messages`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
      expect((await request(app, `/api/buffers/${buffer.id}/export`, { cookie: aliceCookie })).status).toBe(404);
      expect((await request(app, `/api/networks/${network.id}/export`, { cookie: aliceCookie })).status).toBe(404);
      expect(await (await request(app, '/api/search?q=classified', { cookie: aliceCookie })).json())
        .toEqual({ messages: [], hasMore: false });
      expect((await (await request(app, '/api/search?q=classified', { cookie: admin })).json()).messages).toHaveLength(1);
      // Network names are unique per user, not globally.
      expect(store.createNetwork(alice.id, { ...network, saslPassword: '' }).name).toBe('libera');

      const adminSessions = (await (await request(app, '/api/account/sessions', { cookie: admin })).json())
        .sessions as Array<{ id: string }>;
      await request(app, `/api/account/sessions/${adminSessions[0]!.id}`, { method: 'DELETE', cookie: aliceCookie });
      expect((await request(app, '/api/bootstrap', { cookie: admin })).status).toBe(200);

      expect((await request(app, `/api/users/${adminId}/password`, {
        method: 'POST', cookie: admin, body: { password: 'hijacked password' },
      })).status).toBe(404);
      expect((await request(app, `/api/users/${alice.id}/password`, {
        method: 'POST', cookie: admin, body: { password: 'reset password' },
      })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: aliceCookie })).status).toBe(401);
      expect((await login(app, 'alice', 'alice password')).status).toBe(401);
      const aliceAgain = cookieFrom(await login(app, 'alice', 'reset password'));

      expect((await request(app, `/api/users/${adminId}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
      expect((await request(app, `/api/users/${alice.id}`, { method: 'DELETE', cookie: admin })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: aliceAgain })).status).toBe(401);
      expect((await login(app, 'alice', 'reset password')).status).toBe(401);
      expect(store.listNetworks().map(item => item.id)).toEqual([network.id]);
      expect((await (await request(app, '/api/users', { cookie: admin })).json()).users)
        .toEqual([expect.objectContaining({ username: 'root', isAdmin: true })]);
    } finally {
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('streams complete, ordered, time-filtered history exports', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN, now: () => Date.UTC(2026, 8, 23, 12) }).app;
      const cookie = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const network = store.createNetwork(store.listUsers()[0]!.id, {
        name: 'libera', host: 'irc.example.org', port: 6697, tls: true, nick: 'root', username: 'root',
        realname: 'Root', saslAccount: '', autojoin: [], commands: [], relayNicks: [], mentionAliases: [],
        displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      });
      const room = store.getOrCreateBuffer(network.id, '#room', 'channel');
      const query = store.getOrCreateBuffer(network.id, 'bob', 'query');
      const kinds = ['privmsg', 'action', 'notice', 'system'] as const;
      const roomIds: number[] = [];
      const allIds: number[] = [];
      // More than two export pages, interleaved with another buffer so page boundaries skip foreign ids.
      for (let index = 0; index < 2500; index += 1) {
        const kind = kinds[index % kinds.length]!;
        const message = store.appendMessage({
          networkId: network.id, bufferId: room.id, kind, nick: kind === 'system' ? null : 'bob',
          text: `line ${index} \x0304red\x03 \x02bold\x02`, time: Date.UTC(2026, 8, 1) + index * 1000,
        });
        roomIds.push(message.id);
        allIds.push(message.id);
        if (index % 7 === 0) {
          allIds.push(store.appendMessage({
            networkId: network.id, bufferId: query.id, kind: 'privmsg', nick: 'bob', text: `dm ${index}`, time: 1,
          }).id);
        }
      }

      const jsonl = await request(app, `/api/buffers/${room.id}/export?format=jsonl`, { cookie });
      expect(jsonl.status).toBe(200);
      expect(jsonl.headers.get('content-disposition')).toBe('attachment; filename="libera-room-2026-09-23.jsonl"');
      const lines = (await jsonl.text()).trimEnd().split('\n').map(line => JSON.parse(line));
      expect(lines.map(line => line.id)).toEqual(roomIds);
      expect(lines[1]).toEqual({
        id: roomIds[1], networkId: network.id, bufferId: room.id, kind: 'action', nick: 'bob',
        text: 'line 1 \x0304red\x03 \x02bold\x02', time: Date.UTC(2026, 8, 1) + 1000,
      });

      // Both bounds are inclusive; plain text drops formatting codes.
      const since = Date.UTC(2026, 8, 1) + 1000;
      const until = Date.UTC(2026, 8, 1) + 1004 * 1000;
      const text = await request(app, `/api/buffers/${room.id}/export?format=txt&since=${since}&until=${until}`, { cookie });
      expect(text.headers.get('content-type')).toStartWith('text/plain');
      const textLines = (await text.text()).trimEnd().split('\n');
      expect(textLines).toHaveLength(1004);
      expect(textLines.slice(0, 4)).toEqual([
        '[2026-09-01T00:00:01Z] * bob line 1 red bold',
        '[2026-09-01T00:00:02Z] -bob- line 2 red bold',
        '[2026-09-01T00:00:03Z] -- line 3 red bold',
        '[2026-09-01T00:00:04Z] <bob> line 4 red bold',
      ]);
      expect(textLines.at(-1)).toStartWith('[2026-09-01T00:16:44Z] <bob> line 1004 ');

      const networkExport = await request(app, `/api/networks/${network.id}/export`, { cookie });
      expect(networkExport.headers.get('content-disposition')).toBe('attachment; filename="libera-2026-09-23.jsonl"');
      const networkLines = (await networkExport.text()).trimEnd().split('\n').map(line => JSON.parse(line));
      expect(networkLines.map(line => line.id)).toEqual(allIds);
      expect(networkLines[1]).toMatchObject({ bufferId: query.id, bufferName: 'bob', text: 'dm 0' });

      expect((await request(app, `/api/networks/${network.id}/export?format=txt`, { cookie })).status).toBe(400);
      expect((await request(app, `/api/buffers/${room.id}/export?format=csv`, { cookie })).status).toBe(400);
      expect((await request(app, `/api/buffers/${room.id}/export?since=5&until=4`, { cookie })).status).toBe(400);
    } finally {
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('settings are user-scoped, reject foreign IDs atomically, and roundtrip through bootstrap', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      const adminCookie = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const adminId = store.listUsers()[0]!.id;
      const alice = store.createUser('alice', 'scrypt:alice')!;
      const aliceToken = 'a'.repeat(43);
      store.createSession(createHash('sha256').update(aliceToken).digest('hex'), alice.id, Date.now() + 60_000);
      const aliceCookie = `lingo_session=${aliceToken}`;
      const input = {
        name: 'IRC', host: 'irc.example.test', port: 6697, tls: true,
        nick: 'nick', username: 'nick', realname: 'Nick', saslAccount: '',
        autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      };
      const ownNetwork = store.createNetwork(alice.id, input);
      const ownBuffer = store.getOrCreateBuffer(ownNetwork.id, '#own', 'channel');
      const foreignNetwork = store.createNetwork(adminId, input);
      const foreignBuffer = store.getOrCreateBuffer(foreignNetwork.id, '#foreign', 'channel');
      const defaults = {
        highlights: [], mutedBuffers: [], mutedNetworks: [], hiddenBuffers: [],
        collapsedNetworks: [], pushIncludesText: false, sendTyping: false,
      };
      expect((await request(app, '/api/settings')).status).toBe(401);
      expect(await (await request(app, '/api/settings', { cookie: aliceCookie })).json()).toEqual(defaults);
      expect(await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json())
        .toMatchObject({ settings: defaults, settingsConfigured: false });
      const patch = (body: unknown) => request(app, '/api/settings', {
        method: 'PATCH', cookie: aliceCookie, body,
      });
      expect((await patch({ highlights: ['hello'], mutedBuffers: [foreignBuffer.id] })).status).toBe(404);
      expect((await patch({ mutedNetworks: [foreignNetwork.id] })).status).toBe(404);
      expect((await patch({ collapsedNetworks: [foreignNetwork.id] })).status).toBe(404);
      expect((await patch({ hiddenBuffers: [foreignBuffer.id] })).status).toBe(404);
      expect((await patch({ mutedNetworks: [ownNetwork.id, foreignNetwork.id] })).status).toBe(404);
      expect((await patch({ mutedBuffers: [ownBuffer.id, foreignBuffer.id] })).status).toBe(404);
      for (const bad of [
        { unknown: true }, { highlights: [''] }, { highlights: ['x'.repeat(101)] },
        { mutedBuffers: [-1] }, { mutedNetworks: [1.5] }, { hiddenBuffers: ['1'] },
        { collapsedNetworks: [Number.MAX_SAFE_INTEGER + 1] }, { sendTyping: 'true' },
        { highlights: Array(101).fill('x') }, { mutedBuffers: Array(1001).fill(ownBuffer.id) },
      ]) expect((await patch(bad)).status).toBe(400);
      expect(await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json())
        .toMatchObject({ settings: defaults, settingsConfigured: false });
      const first = { ...defaults, highlights: ['hello'], mutedBuffers: [ownBuffer.id], collapsedNetworks: [ownNetwork.id] };
      expect(await (await patch(first)).json()).toEqual(first);
      const merged = { ...first, hiddenBuffers: [ownBuffer.id], mutedNetworks: [ownNetwork.id], sendTyping: true };
      expect(await (await patch({
        hiddenBuffers: [ownBuffer.id], mutedNetworks: [ownNetwork.id], sendTyping: true,
      })).json()).toEqual(merged);
      expect(await (await request(app, '/api/settings', { cookie: aliceCookie })).json()).toEqual(merged);
      expect(await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json())
        .toMatchObject({ settings: merged, settingsConfigured: true });
      expect(await (await request(app, '/api/bootstrap', { cookie: adminCookie })).json())
        .toMatchObject({ settings: defaults, settingsConfigured: false });
      expect((await patch({})).status).toBe(200);
      expect(await (await request(app, '/api/settings', { cookie: aliceCookie })).json()).toEqual(merged);
    } finally {
      manager.stop();
      store.close();
    }
  });

  test('settings events reach only the owner’s live sessions', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    const service = createApp(store, manager, { setupToken: SETUP_TOKEN });
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, fetch: service.app.fetch, websocket: service.websocket,
    });
    const sockets: WebSocket[] = [];
    try {
      const users = ['alice', 'bob'].map(username => store.createUser(username, `scrypt:${username}`)!);
      const tokens = ['a'.repeat(43), 'b'.repeat(43)];
      for (const [index, user] of users.entries()) {
        store.createSession(createHash('sha256').update(tokens[index]!).digest('hex'),
          user.id, Date.now() + 60_000);
      }
      const received: unknown[][] = [[], []];
      const complete: Array<() => void> = [];
      const delivered = users.map((_, index) => new Promise<void>(resolve => { complete[index] = resolve; }));
      const origin = server.url.origin;
      const opened = users.map((_, index) => new Promise<void>((resolve, reject) => {
        const AuthenticatedWebSocket = WebSocket as unknown as
          new (url: string, options: { headers: Record<string, string> }) => WebSocket;
        const socket = new AuthenticatedWebSocket(`${origin.replace('http:', 'ws:')}/api/events`, {
          headers: { Cookie: `lingo_session=${tokens[index]}`, Origin: origin },
        });
        sockets.push(socket);
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('Settings WebSocket failed to open'));
        socket.onmessage = event => {
          received[index]!.push(JSON.parse(String(event.data)));
          if (received[index]!.length === 2) complete[index]!();
        };
      }));
      await Promise.all(opened);
      for (const [index, value] of [[1, 'bob-1'], [0, 'alice-1'], [0, 'alice-2'], [1, 'bob-2']] as const) {
        const response = await fetch(new URL('/api/settings', server.url), {
          method: 'PATCH',
          headers: { cookie: `lingo_session=${tokens[index]}`, origin, 'content-type': 'application/json' },
          body: JSON.stringify({ highlights: [value] }),
        });
        expect(response.status).toBe(200);
      }
      await Promise.all(delivered);
      for (const [index, user] of users.entries()) {
        const settings = store.getSettingsState(user.id).settings;
        expect(received[index]).toEqual([1, 2].map(number => ({
          type: 'settings', userId: user.id,
          settings: { ...settings, highlights: [`${user.username}-${number}`] },
        })));
      }
    } finally {
      for (const socket of sockets) socket.close();
      server.stop(true);
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('read markers require owned messages and expose unread counts on bootstrap', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      const adminCookie = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const created = await request(app, '/api/users', {
        method: 'POST', cookie: adminCookie, body: { username: 'alice', password: 'alice password' },
      });
      const alice = await created.json() as { id: number };
      const aliceCookie = cookieFrom(await login(app, 'alice', 'alice password'));
      const input = {
        name: 'own', host: '127.0.0.1', port: 6667, tls: false, nick: 'alice',
        username: 'alice', realname: 'Alice', saslAccount: '', autojoin: [], commands: [],
        relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      };
      const network = store.createNetwork(alice.id, input);
      const buffer = store.getOrCreateBuffer(network.id, '#room', 'channel');
      const other = store.getOrCreateBuffer(network.id, '#other', 'channel');
      const first = store.appendMessage({
        networkId: network.id, bufferId: buffer.id, kind: 'privmsg', nick: 'bob',
        text: 'alice hello', time: Date.now(), highlight: true,
      });
      const second = store.appendMessage({
        networkId: network.id, bufferId: buffer.id, kind: 'privmsg', nick: 'bob',
        text: 'ordinary', time: Date.now(),
      });
      expect(await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json())
        .toMatchObject({ unread: { [buffer.id]: { messages: 2, mentions: 1, lastReadId: 0 } } });
      const mark = (cookie: string, id: number, messageId: number) =>
        request(app, `/api/buffers/${id}/read`, { method: 'PUT', cookie, body: { messageId } });
      expect((await mark(adminCookie, buffer.id, second.id)).status).toBe(404);
      expect((await mark(aliceCookie, other.id, second.id)).status).toBe(404);
      expect((await mark(aliceCookie, buffer.id, first.id)).status).toBe(200);
      expect((await mark(aliceCookie, buffer.id, second.id)).status).toBe(200);
      expect(await (await mark(aliceCookie, buffer.id, first.id)).json())
        .toEqual({ bufferId: buffer.id, lastReadId: second.id });
      expect(await (await request(app, '/api/bootstrap', { cookie: aliceCookie })).json())
        .toMatchObject({ unread: { [buffer.id]: { messages: 0, mentions: 0, lastReadId: second.id } } });
    } finally {
      manager.stop();
      store.close();
    }
  });

  test('read events reach only the buffer owner’s sockets', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    const service = createApp(store, manager);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch, websocket: service.websocket });
    const sockets: WebSocket[] = [];
    try {
      const users = ['alice', 'bob'].map(name => store.createUser(name, `scrypt:${name}`)!);
      const tokens = ['a'.repeat(43), 'b'.repeat(43)];
      const network = store.createNetwork(users[0]!.id, {
        name: 'mock', host: '127.0.0.1', port: 6667, tls: false, nick: 'alice',
        username: 'alice', realname: 'Alice', saslAccount: '', autojoin: [], commands: [],
        relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      });
      const buffer = store.getOrCreateBuffer(network.id, '#room', 'channel');
      const message = store.appendMessage({
        networkId: network.id, bufferId: buffer.id, kind: 'privmsg', nick: 'third',
        text: 'hello', time: Date.now(),
      });
      for (const [index, user] of users.entries()) {
        store.createSession(createHash('sha256').update(tokens[index]!).digest('hex'), user.id, Date.now() + 60_000);
      }
      const received: unknown[][] = [[], []];
      const delivery = Promise.withResolvers<void>();
      const origin = server.url.origin;
      const SocketWithHeaders = WebSocket as unknown as
        new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      await Promise.all(users.map((_, index) => new Promise<void>((resolve, reject) => {
        const socket = new SocketWithHeaders(`${origin.replace('http:', 'ws:')}/api/events`, {
          headers: { Cookie: `lingo_session=${tokens[index]}`, Origin: origin },
        });
        sockets.push(socket);
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('Read WebSocket failed to open'));
        socket.onmessage = event => {
          received[index]!.push(JSON.parse(String(event.data)));
          delivery.resolve();
        };
      })));
      const response = await fetch(new URL(`/api/buffers/${buffer.id}/read`, server.url), {
        method: 'PUT',
        headers: { cookie: `lingo_session=${tokens[0]}`, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: message.id }),
      });
      expect(response.status).toBe(200);
      await delivery.promise;
      expect(received[0]).toEqual([{ type: 'read', bufferId: buffer.id, lastReadId: message.id }]);
      expect(received[1]).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
      server.stop(true);
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('enforces account network quotas through authenticated network creation', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      const admin = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const created = await request(app, '/api/users', {
        method: 'POST', cookie: admin, body: { username: 'alice', password: 'alice password' },
      });
      const alice = await created.json() as { id: number };
      const aliceCookie = cookieFrom(await login(app, 'alice', 'alice password'));
      const input = {
        name: 'one', host: '127.0.0.1', port: 6667, tls: false, nick: 'alice',
        username: 'alice', realname: 'Alice', saslAccount: '', autojoin: [], commands: [],
        relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      };
      const patch = (body: unknown) => request(app, `/api/users/${alice.id}`, {
        method: 'PATCH', cookie: admin, body,
      });
      expect((await patch({ maxNetworks: -1 })).status).toBe(400);
      expect((await patch({ retentionDays: 0 })).status).toBe(400);
      expect((await patch({})).status).toBe(400);
      expect((await patch({ maxNetworks: 0, retentionDays: 30 })).status).toBe(200);
      const blocked = await request(app, '/api/networks', { method: 'POST', cookie: aliceCookie, body: input });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: 'Network limit reached' });
      expect(store.listNetworks(alice.id)).toEqual([]);
      expect((await patch({ maxNetworks: 1 })).status).toBe(200);
      store.createNetwork(alice.id, input);
      expect((await request(app, '/api/networks', {
        method: 'POST', cookie: aliceCookie, body: { ...input, name: 'two' },
      })).status).toBe(409);
      expect((await (await patch({ maxNetworks: null, retentionDays: null })).json()))
        .toMatchObject({ maxNetworks: null, retentionDays: null });
      expect((await request(app, '/api/networks', {
        method: 'POST', cookie: aliceCookie, body: { ...input, name: 'two' },
      })).status).toBe(201);
    } finally {
      manager.stop();
      store.close();
    }
  }, 10_000);

  test('disabling an account revokes sessions and IRC, then restores eligible networks', async () => {
    const updates = new EventEmitter();
    const sockets: Socket[] = [];
    const closed = new Set<Socket>();
    const peer = createServer(socket => {
      let pending = '';
      let nick = '';
      let hasUser = false;
      let capEnded = false;
      let welcomed = false;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string | Buffer) => {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end).replace(/\r$/, '');
          pending = pending.slice(end + 1);
          if (line.startsWith('CAP LS ')) socket.write(':mock CAP * LS :\r\n');
          else if (line.startsWith('CAP REQ :')) socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
          else if (line.startsWith('NICK ')) nick = line.slice('NICK '.length);
          else if (line.startsWith('USER ')) hasUser = true;
          else if (line === 'CAP END') capEnded = true;
          if (!welcomed && nick && hasUser && capEnded) {
            welcomed = true;
            socket.write(`:mock 001 ${nick} :Welcome\r\n`);
          }
          updates.emit('change');
        }
      });
      sockets.push(socket);
      socket.on('close', () => { closed.add(socket); updates.emit('change'); });
      updates.emit('change');
    });
    const waitFor = (condition: () => boolean, description: string) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        updates.off('change', check);
        reject(new Error(`Timed out waiting for ${description}`));
      }, 5_000);
      const check = () => {
        if (!condition()) return;
        clearTimeout(timeout);
        updates.off('change', check);
        resolve();
      };
      updates.on('change', check);
      check();
    });
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => updates.emit('change'));
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once('error', reject);
        peer.listen(0, '127.0.0.1', resolve);
      });
      const address = peer.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP port');
      const app = createApp(store, manager, { setupToken: SETUP_TOKEN }).app;
      const admin = cookieFrom(await request(app, '/api/setup', { method: 'POST', body: SETUP }));
      const created = await request(app, '/api/users', {
        method: 'POST', cookie: admin, body: { username: 'alice', password: 'alice password' },
      });
      const alice = await created.json() as { id: number };
      const input = {
        name: 'live', host: '127.0.0.1', port: address.port, tls: false, nick: 'alice',
        username: 'alice', realname: 'Alice', saslAccount: '', autojoin: [], commands: [],
        relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      };
      const live = store.createNetwork(alice.id, input);
      const offline = store.createNetwork(alice.id, { ...input, name: 'offline' });
      store.setNetworkDisconnected(offline.id, true);
      manager.start();
      await waitFor(() => manager.status(alice.id)[live.id]?.state === 'connected', 'initial IRC registration');
      const aliceCookie = cookieFrom(await login(app, 'alice', 'alice password'));
      const before = (await (await request(app, '/api/users', { cookie: admin })).json()).users;
      expect(before.find((user: { id: number }) => user.id === alice.id)).toMatchObject({
        disabled: false, networkCount: 2, sessionCount: 1, lastLoginAt: expect.any(Number),
      });
      const adminId = store.listUsers().find(user => user.isAdmin)!.id;
      expect((await request(app, `/api/users/${adminId}`, {
        method: 'PATCH', cookie: admin, body: { disabled: true },
      })).status).toBe(400);
      expect((await request(app, `/api/users/${alice.id}`, {
        method: 'PATCH', cookie: aliceCookie, body: { disabled: true },
      })).status).toBe(403);
      expect((await request(app, `/api/users/${alice.id}`, {
        method: 'PATCH', cookie: admin, body: { disabled: 'yes' },
      })).status).toBe(400);
      const disable = await request(app, `/api/users/${alice.id}`, {
        method: 'PATCH', cookie: admin, body: { disabled: true },
      });
      expect(disable.status).toBe(200);
      expect(await disable.json()).toMatchObject({ disabled: true, sessionCount: 0, connectedCount: 0 });
      await waitFor(() => closed.has(sockets[0]!), 'IRC socket close');
      expect((await request(app, '/api/bootstrap', { cookie: aliceCookie })).status).toBe(401);
      expect((await login(app, 'alice', 'incorrect')).status).toBe(401);
      expect(await (await login(app, 'alice', 'alice password')).json()).toEqual({ error: 'Account disabled' });
      manager.stop();
      manager.start();
      expect(manager.status(alice.id)[live.id]?.state).toBe('disconnected');
      expect(sockets).toHaveLength(1);
      const enable = await request(app, `/api/users/${alice.id}`, {
        method: 'PATCH', cookie: admin, body: { disabled: false },
      });
      expect(enable.status).toBe(200);
      await waitFor(() => sockets.length === 2, 're-enabled IRC connection');
      expect(store.isNetworkDisconnected(offline.id)).toBe(true);
      expect(cookieFrom(await login(app, 'alice', 'alice password'))).toMatch(/^lingo_session=/);
    } finally {
      manager.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => peer.close(() => resolve()));
      store.close();
    }
  }, 15_000);
});
