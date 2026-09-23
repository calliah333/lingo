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
});
