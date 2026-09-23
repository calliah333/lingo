import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from '../src/server/app.ts';
import { IrcManager } from '../src/server/irc.ts';
import { Store } from '../src/server/store.ts';

const HOST = 'lingo.test';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery staple';

function request(
  app: Hono,
  path: string,
  options: { method?: string; origin?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ host: HOST, origin: options.origin ?? ORIGIN });
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return Promise.resolve(app.request(`http://${HOST}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

describe('session and origin authorization', () => {
  test('protects content, enforces same-origin mutations, and revokes logout sessions', async () => {
    const store = new Store(':memory:');
    const manager = new IrcManager(store, () => {});
    try {
      const app = createApp(store, manager, PASSWORD).app;

      expect((await request(app, '/api/bootstrap')).status).toBe(401);
      expect((await request(app, '/api/login', {
        method: 'POST',
        body: { password: 'incorrect password' },
      })).status).toBe(401);
      expect((await request(app, '/api/login', {
        method: 'POST',
        origin: 'http://attacker.test',
        body: { password: PASSWORD },
      })).status).toBe(403);

      const login = await request(app, '/api/login', {
        method: 'POST',
        body: { password: PASSWORD },
      });
      expect(login.status).toBe(200);
      const loginBody = await login.text();
      expect(loginBody).not.toContain(PASSWORD);
      const setCookie = login.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      const token = setCookie?.match(/(?:^|,\s*)lingo_session=([^;,\s]+)/)?.[1];
      expect(token).toBeTruthy();
      const cookie = `lingo_session=${token}`;

      expect((await request(app, '/api/bootstrap', { cookie })).status).toBe(200);
      expect((await request(app, '/api/logout', {
        method: 'POST',
        origin: 'http://attacker.test',
        cookie,
      })).status).toBe(403);

      // A new app instance must recognize the persisted server-side session.
      const recreatedApp = createApp(store, manager, PASSWORD).app;
      expect((await request(recreatedApp, '/api/bootstrap', { cookie })).status).toBe(200);

      expect((await request(recreatedApp, '/api/logout', {
        method: 'POST',
        cookie,
      })).status).toBe(200);
      const proxiedApp = createApp(store, manager, PASSWORD, 'https://irc.example.com').app;
      expect((await request(proxiedApp, '/api/login', {
        method: 'POST',
        origin: 'https://attacker.test',
        body: { password: PASSWORD },
      })).status).toBe(403);
      const proxiedLogin = await request(proxiedApp, '/api/login', {
        method: 'POST',
        origin: 'https://irc.example.com',
        body: { password: PASSWORD },
      });
      expect(proxiedLogin.status).toBe(200);
      expect(proxiedLogin.headers.get('set-cookie')).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
      expect((await request(app, '/api/bootstrap', { cookie })).status).toBe(401);
    } finally {
      manager.stop();
      store.close();
    }
  }, 5_000);
  test('manages persisted account sessions and rotates the password', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingo-auth-'));
    const databasePath = join(directory, 'account.sqlite');
    let store = new Store(databasePath);
    let manager = new IrcManager(store, () => {});
    let storeOpen = true;
    let managerRunning = true;
    try {
      const app = createApp(store, manager, PASSWORD).app;
      const login = async (password: string) => request(app, '/api/login', {
        method: 'POST',
        body: { password },
      });
      const cookieFrom = (response: Response) => {
        expect(response.status).toBe(200);
        const token = response.headers.get('set-cookie')?.match(/(?:^|,\s*)lingo_session=([^;,\s]+)/)?.[1];
        expect(token).toBeTruthy();
        return `lingo_session=${token}`;
      };
      const loginA = await login(PASSWORD);
      const cookieA = cookieFrom(loginA);
      const loginB = await login(PASSWORD);
      const cookieB = cookieFrom(loginB);
      expect(cookieA).not.toBe(cookieB);

      const sessionsResponse = await request(app, '/api/account/sessions', { cookie: cookieA });
      expect(sessionsResponse.status).toBe(200);
      const sessions = (await sessionsResponse.json()).sessions as Array<{ id: string; current: boolean }>;
      expect(sessions).toHaveLength(2);
      const currentSession = sessions.find(session => session.current);
      const otherSession = sessions.find(session => !session.current);
      expect(currentSession).toBeDefined();
      expect(otherSession).toBeDefined();

      const otherSessionId = otherSession?.id;
      expect(otherSessionId).toBeTruthy();
      expect((await request(app, `/api/account/sessions/${otherSessionId}`, {
        method: 'DELETE',
        origin: 'http://attacker.test',
        cookie: cookieA,
      })).status).toBe(403);
      expect((await request(app, '/api/bootstrap', { cookie: cookieB })).status).toBe(200);
      expect((await request(app, `/api/account/sessions/${otherSessionId}`, {
        method: 'DELETE',
        cookie: cookieA,
      })).status).toBe(200);
      expect((await request(app, '/api/bootstrap', { cookie: cookieB })).status).toBe(401);

      const secondB = await login(PASSWORD);
      const cookieSecondB = cookieFrom(secondB);
      const refreshedSessions = (await (await request(app, '/api/account/sessions', {
        cookie: cookieA,
      })).json()).sessions as Array<{ id: string; current: boolean }>;
      const newOtherId = refreshedSessions.find(session => !session.current)?.id;
      expect(newOtherId).toBeTruthy();
      expect((await request(app, '/api/account/password', {
        method: 'POST',
        origin: 'http://attacker.test',
        cookie: cookieA,
        body: { currentPassword: PASSWORD, newPassword: 'new secure password' },
      })).status).toBe(403);
      expect((await request(app, `/api/account/sessions/${newOtherId}`, {
        method: 'DELETE',
        origin: 'http://attacker.test',
        cookie: cookieA,
      })).status).toBe(403);
      expect((await request(app, '/api/bootstrap', { cookie: cookieSecondB })).status).toBe(200);

      expect((await request(app, '/api/account/password', {
        method: 'POST',
        cookie: cookieA,
        body: { currentPassword: 'wrong password', newPassword: 'new secure password' },
      })).status).toBe(401);
      expect((await login(PASSWORD)).status).toBe(200);

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
      const reopenedApp = createApp(store, manager, PASSWORD).app;
      expect((await request(reopenedApp, '/api/bootstrap', { cookie: cookieA })).status).toBe(200);
      expect((await request(reopenedApp, '/api/login', {
        method: 'POST',
        body: { password: PASSWORD },
      })).status).toBe(401);
      expect((await request(reopenedApp, '/api/login', {
        method: 'POST',
        body: { password: 'new secure password' },
      })).status).toBe(200);
    } finally {
      if (managerRunning) manager.stop();
      if (storeOpen) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
