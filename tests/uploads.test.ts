import { afterEach, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { UploadCapabilities, UploadRecord } from '../src/shared/contracts.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { IrcManager } from '../src/server/irc.ts';
import { Store } from '../src/server/store.ts';
import { cleanFilename, TeacupClient, uploadConfig, type UploadConfig } from '../src/server/uploads.ts';

const HOST = 'lingo.test';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery staple';
const TEACUP_PASSWORD = 'teacup-secret-password';
const PUBLIC_URL = 'https://files.example.test';
const MIB = 1024 * 1024;

type App = Hono<AppEnv>;
type Recorded = { method: string; path: string; authorization: string | null; form: FormData | null };

/** A stand-in teacup whose responses each test can override; it records every request. */
class FakeTeacup {
  readonly requests: Recorded[] = [];
  capabilities: { status?: number; body: unknown } = {
    body: { apiVersion: 1, maxFileSizeBytes: 100 * MIB, maxTtlSeconds: null, permanentAllowed: true },
  };
  upload?: (form: FormData) => { status: number; body: unknown };
  deleteStatus = 200;
  private next = 0;
  private readonly server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url);
      const form = request.method === 'POST' ? await request.formData() : null;
      this.requests.push({ method: request.method, path: url.pathname, authorization: request.headers.get('authorization'), form });
      if (url.pathname === '/api/capabilities') {
        return Response.json(this.capabilities.body, {
          status: this.capabilities.status ?? 200, headers: { 'Cache-Control': 'max-age=60' },
        });
      }
      if (url.pathname === '/upload') {
        if (this.upload) {
          const { status, body } = this.upload(form!);
          return Response.json(body, { status });
        }
        const file = form!.get('file') as File;
        const hash = `file${String(this.next++).padStart(9, '0')}`;
        const extension = file.name.slice(file.name.lastIndexOf('.'));
        return Response.json({
          success: true,
          // teacup builds links from the Host it was reached at, i.e. its internal address.
          files: [{ hash, filename: file.name, extension, url: `${this.url}/${hash}${extension}` }],
        });
      }
      if (url.pathname.startsWith('/api/files/')) {
        return Response.json({ success: this.deleteStatus === 200 }, { status: this.deleteStatus });
      }
      return new Response('Not found', { status: 404 });
    },
  });

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  uploads(): Recorded[] {
    return this.requests.filter(request => request.path === '/upload');
  }

  stop(): void {
    this.server.stop(true);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function config(teacup: FakeTeacup | string, maxMb = 25): UploadConfig {
  return uploadConfig({
    LINGO_TEACUP_URL: typeof teacup === 'string' ? teacup : teacup.url,
    LINGO_TEACUP_USERNAME: 'lingo',
    LINGO_TEACUP_PASSWORD: TEACUP_PASSWORD,
    LINGO_TEACUP_PUBLIC_URL: PUBLIC_URL,
    LINGO_UPLOAD_MAX_MB: String(maxMb),
  })!;
}

async function request(
  app: App, path: string, options: { method?: string; cookie?: string; body?: unknown; form?: FormData; length?: string } = {},
): Promise<Response> {
  const headers = new Headers({ host: HOST, origin: ORIGIN });
  if (options.cookie) headers.set('cookie', options.cookie);
  let body: BodyInit | undefined;
  if (options.form) {
    const encoded = new Response(options.form);
    headers.set('content-type', encoded.headers.get('content-type')!);
    body = await encoded.arrayBuffer();
    headers.set('content-length', options.length ?? String(body.byteLength));
  } else if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  return app.request(`http://${HOST}${path}`, { method: options.method ?? 'GET', headers, body });
}

function sessionCookie(response: Response): string {
  expect(response.status).toBe(200);
  return `lingo_session=${response.headers.get('set-cookie')!.match(/lingo_session=([^;]+)/)![1]}`;
}

/** An app with a claimed admin (`root`, who may upload) and a regular user (`bob`, who may not). */
async function setup(uploads?: TeacupClient, now?: () => number) {
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => {});
  cleanups.push(() => {
    manager.stop();
    store.close();
  });
  const app = createApp(store, manager, { setupToken: 'token', uploads, now }).app;
  const admin = sessionCookie(await request(app, '/api/setup', {
    method: 'POST', body: { username: 'root', password: PASSWORD, token: 'token' },
  }));
  const created = await request(app, '/api/users', { method: 'POST', cookie: admin, body: { username: 'bob', password: PASSWORD } });
  const bobId = ((await created.json()) as { id: number }).id;
  const bob = sessionCookie(await request(app, '/api/login', {
    method: 'POST', body: { username: 'bob', password: PASSWORD },
  }));
  return { app, store, admin, bob, bobId };
}

function fakeTeacup(): FakeTeacup {
  const teacup = new FakeTeacup();
  cleanups.push(() => teacup.stop());
  return teacup;
}

function fileForm(file: File, expiry = '7d'): FormData {
  const form = new FormData();
  form.append('file', file);
  form.append('expiry', expiry);
  return form;
}

const png = (name = 'shot.png', size = 16) => new File([new Uint8Array(size)], name, { type: 'image/png' });

async function capabilities(app: App, cookie: string): Promise<UploadCapabilities> {
  const response = await request(app, '/api/uploads/capabilities', { cookie });
  expect(response.status).toBe(200);
  return response.json() as Promise<UploadCapabilities>;
}

test('uploads through teacup with Lingo’s credentials and publishes a public link', async () => {
  const teacup = fakeTeacup();
  const { app, admin } = await setup(new TeacupClient(config(teacup)), () => 1_000_000);

  const response = await request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(png('../../a b.p!ng')) });
  expect(response.status).toBe(201);
  const record = await response.json() as UploadRecord;
  expect(record).toEqual({
    id: 1, url: `${PUBLIC_URL}/file000000000.png`, filename: 'a_b.png', size: 16,
    expiresAt: 1_000_000 + 7 * 86_400_000, createdAt: 1_000_000,
  });
  const [sent] = teacup.uploads();
  expect(sent!.authorization).toBe(`Basic ${btoa(`lingo:${TEACUP_PASSWORD}`)}`);
  expect(sent!.form!.getAll('file')).toHaveLength(1);
  expect((sent!.form!.get('file') as File).name).toBe('a_b.png');
  expect(sent!.form!.get('ttl_seconds')).toBe(String(7 * 86_400));
  expect(sent!.form!.has('permanent')).toBe(false);

  const permanent = await request(app, '/api/uploads', {
    method: 'POST', cookie: admin, form: fileForm(png(), 'permanent'),
  });
  expect(await permanent.json()).toMatchObject({ expiresAt: null });
  expect(teacup.uploads()[1]!.form!.get('permanent')).toBe('true');
  expect(teacup.uploads()[1]!.form!.has('ttl_seconds')).toBe(false);

  const list = await (await request(app, '/api/uploads?limit=1', { cookie: admin })).json();
  expect(list).toMatchObject({ uploads: [{ id: 2 }], hasMore: true });
  expect(await (await request(app, '/api/uploads?before=2', { cookie: admin })).json())
    .toEqual({ uploads: [record], hasMore: false });
});

test('filenames keep only a safe basename and always carry a short extension', () => {
  expect(cleanFilename('../../a b.p!ng', 'image/png')).toBe('a_b.png');
  expect(cleanFilename('C:\\Users\\me\\report.final.PDF', 'application/pdf')).toBe('report.final.PDF');
  expect(cleanFilename('README', 'text/plain; charset=utf-8')).toBe('README.txt');
  expect(cleanFilename('archive.tar.verylongextension', '')).toBe('archive.tar.verylongextension.bin');
  expect(cleanFilename('image.png', 'image/png')).toBe('image.png');
  expect(cleanFilename('фото', 'image/jpeg')).toBe('paste.jpg');
  expect(cleanFilename('.env', '')).toBe('upload.env');
  expect(cleanFilename('', 'application/x-unknown')).toBe('upload.bin');
  const long = cleanFilename(`${'x'.repeat(300)}.png`, 'image/png');
  expect(long).toHaveLength(100);
  expect(long.endsWith('x.png')).toBe(true);
});

test('oversized uploads are refused before reaching teacup', async () => {
  const teacup = fakeTeacup();
  const { app, admin } = await setup(new TeacupClient(config(teacup, 1)));
  // The declared length alone rules it out, before the body is read.
  const declared = await request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(png()), length: String(3 * MIB) });
  expect(declared.status).toBe(413);
  // Within the multipart allowance, but the file itself is over the limit.
  const actual = await request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(png('big.png', MIB + 1)) });
  expect(actual.status).toBe(413);
  expect(teacup.uploads()).toEqual([]);
});

test('uploading needs permission, and the routes disappear when uploads are not configured', async () => {
  const teacup = fakeTeacup();
  const { app, admin, bob, bobId } = await setup(new TeacupClient(config(teacup)));
  expect(await capabilities(app, bob)).toEqual({ enabled: false, reason: 'not_permitted' });
  expect((await request(app, '/api/uploads', { method: 'POST', cookie: bob, form: fileForm(png()) })).status).toBe(403);
  expect(teacup.uploads()).toEqual([]);

  const granted = await request(app, `/api/users/${bobId}`, { method: 'PATCH', cookie: admin, body: { canUpload: true } });
  expect(await granted.json()).toMatchObject({ id: bobId, canUpload: true });
  expect(await capabilities(app, bob)).toMatchObject({ enabled: true });
  expect((await request(app, '/api/uploads', { method: 'POST', cookie: bob, form: fileForm(png()) })).status).toBe(201);

  const off = await setup();
  expect(await capabilities(off.app, off.admin)).toEqual({ enabled: false, reason: 'not_configured' });
  expect((await request(off.app, '/api/uploads', { method: 'POST', cookie: off.admin, form: fileForm(png()) })).status).toBe(404);
  expect((await request(off.app, '/api/uploads', { cookie: off.admin })).status).toBe(404);
  expect((await request(off.app, '/api/uploads/1', { method: 'DELETE', cookie: off.admin })).status).toBe(404);
});

test('capabilities follow teacup’s limits and refuse unknown API versions', async () => {
  const teacup = fakeTeacup();
  const client = new TeacupClient(config(teacup, 25));
  const { app, admin } = await setup(client);
  expect(await capabilities(app, admin)).toEqual({
    enabled: true, maxBytes: 25 * MIB, expiries: ['1h', '1d', '7d', '30d', 'permanent'], defaultExpiry: '7d',
  });

  teacup.capabilities = { body: { apiVersion: 1, maxFileSizeBytes: 2 * MIB, maxTtlSeconds: 86_400, permanentAllowed: false } };
  // Cached for teacup's max-age until an upload fails or the cache is dropped.
  expect(await capabilities(app, admin)).toMatchObject({ maxBytes: 25 * MIB });
  client.invalidate();
  expect(await capabilities(app, admin)).toEqual({ enabled: true, maxBytes: 2 * MIB, expiries: ['1h', '1d'], defaultExpiry: '1d' });
  for (const expiry of ['7d', 'permanent', 'forever']) {
    expect((await request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(png(), expiry) })).status).toBe(400);
  }
  expect(teacup.uploads()).toEqual([]);

  teacup.capabilities = { body: { apiVersion: 2, maxFileSizeBytes: MIB, maxTtlSeconds: null, permanentAllowed: true } };
  client.invalidate();
  expect(await capabilities(app, admin)).toEqual({ enabled: false, reason: 'unavailable' });
  // An older teacup without the capabilities route.
  teacup.capabilities = { status: 404, body: { error: 'Not found' } };
  client.invalidate();
  expect(await capabilities(app, admin)).toEqual({ enabled: false, reason: 'unavailable' });

  const down = await setup(new TeacupClient(config('http://127.0.0.1:9')));
  expect(await capabilities(down.app, down.admin)).toEqual({ enabled: false, reason: 'unavailable' });
});

test('teacup failures become user-facing errors without leaking credentials or its address', async () => {
  const teacup = fakeTeacup();
  const { app, admin } = await setup(new TeacupClient(config(teacup)));
  const upload = () => request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(png()) });

  teacup.upload = () => ({
    status: 400, body: { success: false, files: [], error: 'No files were uploaded', errors: [{ filename: 'shot.png', error: 'File type blocked' }] },
  });
  let response = await upload();
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: 'File type blocked' });

  teacup.upload = () => ({ status: 200, body: { success: true, files: [] } });
  expect((await upload()).status).toBe(502);

  teacup.upload = () => ({ status: 200, body: { success: true, files: [{ hash: 'abcdefgh', url: 'http://x/../../etc.png' }] } });
  expect((await upload()).status).toBe(502);

  teacup.upload = () => ({ status: 401, body: { success: false, error: 'Authentication required' } });
  response = await upload();
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).not.toContain(TEACUP_PASSWORD);
  expect(text).not.toContain(teacup.url);
  expect(text).not.toContain('127.0.0.1');
  expect(await (await request(app, '/api/uploads', { cookie: admin })).json()).toEqual({ uploads: [], hasMore: false });
});

test('users delete only their own uploads, and deleting an account removes its files', async () => {
  const teacup = fakeTeacup();
  const { app, admin, bob, bobId } = await setup(new TeacupClient(config(teacup)));
  await request(app, `/api/users/${bobId}`, { method: 'PATCH', cookie: admin, body: { canUpload: true } });
  const upload = async (cookie: string) =>
    (await (await request(app, '/api/uploads', { method: 'POST', cookie, form: fileForm(png()) })).json()) as UploadRecord;
  const mine = await upload(admin);
  const expired = await upload(admin);
  const bobs = await upload(bob);
  const deletes = () => teacup.requests.filter(request => request.method === 'DELETE').map(request => request.path);

  expect((await request(app, `/api/uploads/${bobs.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
  expect(deletes()).toEqual([]);
  expect((await request(app, `/api/uploads/${mine.id}`, { method: 'DELETE', cookie: admin })).status).toBe(200);
  expect(deletes()).toEqual(['/api/files/file000000000']);
  // teacup already expired this one; the record goes anyway.
  teacup.deleteStatus = 404;
  expect((await request(app, `/api/uploads/${expired.id}`, { method: 'DELETE', cookie: admin })).status).toBe(200);
  expect(await (await request(app, '/api/uploads', { cookie: admin })).json()).toEqual({ uploads: [], hasMore: false });
  expect((await request(app, `/api/uploads/${mine.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
  teacup.deleteStatus = 500;
  expect((await request(app, `/api/uploads/${bobs.id}`, { method: 'DELETE', cookie: bob })).status).toBe(502);
  expect(await (await request(app, '/api/uploads', { cookie: bob })).json()).toMatchObject({ uploads: [{ id: bobs.id }] });

  teacup.deleteStatus = 200;
  expect((await request(app, `/api/users/${bobId}`, { method: 'DELETE', cookie: admin })).status).toBe(200);
  expect(deletes().at(-1)).toBe('/api/files/file000000002');
});

test('uploads are limited per hour and per day', async () => {
  const teacup = fakeTeacup();
  let time = 10_000_000;
  const { app, admin } = await setup(new TeacupClient(config(teacup)), () => time);
  const upload = (file = png()) => request(app, '/api/uploads', { method: 'POST', cookie: admin, form: fileForm(file) });
  for (let index = 0; index < 30; index++) {
    expect((await upload()).status).toBe(201);
    time += 1000;
  }
  const blocked = await upload();
  expect(blocked.status).toBe(429);
  // The first upload leaves the hourly window 3600 s after it was made, 30 s from now.
  expect(blocked.headers.get('retry-after')).toBe('3570');
  expect(teacup.uploads()).toHaveLength(30);
  time += 3570_000;
  expect((await upload()).status).toBe(201);

  // 20 uploads of 25 MiB fill the 500 MiB daily budget.
  time += 86_400_000;
  for (let index = 0; index < 20; index++) {
    expect((await upload(png('big.png', 25 * MIB))).status).toBe(201);
  }
  const overBudget = await upload(png('one.png', 16));
  expect(overBudget.status).toBe(429);
  expect(overBudget.headers.get('retry-after')).toBe('86400');
}, 30_000);
