import type { UploadExpiry } from '../shared/contracts.ts';

/** Where Lingo reaches teacup, how links are published, and Lingo's own per-file limit. */
export interface UploadConfig {
  url: string;
  username: string;
  password: string;
  publicUrl: string;
  maxBytes: number;
}

/** The part of teacup's `GET /api/capabilities` (apiVersion 1) that Lingo relies on. */
export interface TeacupCapabilities {
  maxFileSizeBytes: number;
  maxTtlSeconds: number | null;
  permanentAllowed: boolean;
}

/** An upload failure safe to show the user; `status` is the HTTP status Lingo answers with. */
export class UploadError extends Error {
  constructor(message: string, readonly status: 422 | 502) {
    super(message);
    this.name = 'UploadError';
  }
}

export const EXPIRY_SECONDS: Record<Exclude<UploadExpiry, 'permanent'>, number> = {
  '1h': 3600,
  '1d': 86_400,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
};

export const UPLOADS_PER_HOUR = 30;
export const UPLOAD_BYTES_PER_DAY = 500 * 1024 * 1024;
/** Room for multipart boundaries, part headers, and the `expiry` field around one file. */
export const MULTIPART_OVERHEAD = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const HASH_PATTERN = /^[0-9a-z]{8,64}$/;
const PATH_PATTERN = /^\/([0-9a-z]{8,64})\.[A-Za-z0-9]{1,10}$/;
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,10}$/;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'text/plain': 'txt', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

function baseUrl(value: string, name: string, publicLink: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && (!publicLink || local));
  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw new Error(publicLink
      ? `${name} must be an https: URL (http: only for localhost) without credentials, query, or fragment`
      : `${name} must be an http(s) URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/+$/, '');
}

/** Reads the teacup settings; null when uploads are not configured. Throws on an invalid configuration. */
export function uploadConfig(env: Record<string, string | undefined>): UploadConfig | null {
  const url = env.LINGO_TEACUP_URL;
  if (!url) return null;
  const { LINGO_TEACUP_USERNAME: username, LINGO_TEACUP_PASSWORD: password } = env;
  if (!username || !password) {
    throw new Error('LINGO_TEACUP_USERNAME and LINGO_TEACUP_PASSWORD are required when LINGO_TEACUP_URL is set');
  }
  const megabytes = Number(env.LINGO_UPLOAD_MAX_MB ?? '25');
  if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > 500) {
    throw new Error('LINGO_UPLOAD_MAX_MB must be an integer between 1 and 500');
  }
  const base = baseUrl(url, 'LINGO_TEACUP_URL', false);
  return {
    url: base,
    username,
    password,
    publicUrl: baseUrl(env.LINGO_TEACUP_PUBLIC_URL ?? url,
      env.LINGO_TEACUP_PUBLIC_URL === undefined ? 'LINGO_TEACUP_PUBLIC_URL (defaulting to LINGO_TEACUP_URL)' : 'LINGO_TEACUP_PUBLIC_URL',
      true),
    maxBytes: megabytes * 1024 * 1024,
  };
}

/** Lingo's presets that teacup accepts, shortest first, then `permanent` when allowed. */
export function offeredExpiries(capabilities: TeacupCapabilities): UploadExpiry[] {
  const { maxTtlSeconds, permanentAllowed } = capabilities;
  const expiries = (Object.keys(EXPIRY_SECONDS) as Array<keyof typeof EXPIRY_SECONDS>)
    .filter(expiry => maxTtlSeconds === null || EXPIRY_SECONDS[expiry] <= maxTtlSeconds) as UploadExpiry[];
  return permanentAllowed ? [...expiries, 'permanent'] : expiries;
}

/** Seven days when offered, else the longest offered lifetime. */
export function defaultExpiry(expiries: UploadExpiry[]): UploadExpiry {
  if (expiries.includes('7d')) return '7d';
  return expiries.filter(expiry => expiry !== 'permanent').at(-1) ?? expiries[0]!;
}

/**
 * A name teacup can safely derive its URL extension from: the basename restricted to
 * `[A-Za-z0-9._-]` (whitespace becomes `_`), at most 100 characters, and always ending in a
 * short alphanumeric extension, taken from the MIME type (or `bin`) when the name has none.
 */
export function cleanFilename(name: string, type: string): string {
  const base = (name.split(/[\\/]/).at(-1) ?? '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '');
  const dot = base.lastIndexOf('.');
  const suffix = dot >= 0 ? base.slice(dot + 1) : '';
  const named = EXTENSION_PATTERN.test(suffix);
  const extension = named ? suffix : MIME_EXTENSIONS[type.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
  const stem = (named ? base.slice(0, dot) : base).replace(/^[._-]+/, '').replace(/\.+$/, '')
    .slice(0, 100 - extension.length - 1) || (type.startsWith('image/') ? 'paste' : 'upload');
  return `${stem}.${extension}`;
}

/**
 * Milliseconds until one more upload of `size` bytes fits both the hourly count and the
 * daily byte budget, or 0 when it fits now. `recent` is oldest first and covers at least a day.
 */
export function uploadRetryAfter(
  recent: Array<{ createdAt: number; size: number }>, inFlight: { count: number; bytes: number }, size: number, now: number,
): number {
  let wait = 0;
  const hourly = recent.filter(upload => upload.createdAt > now - HOUR);
  const excess = hourly.length + inFlight.count + 1 - UPLOADS_PER_HOUR;
  if (excess > 0) {
    // In-flight uploads are not recorded yet; if only they are over the limit, check back shortly.
    const oldest = hourly[excess - 1];
    wait = oldest ? oldest.createdAt + HOUR - now : 60_000;
  }
  const daily = recent.filter(upload => upload.createdAt > now - DAY);
  let bytes = daily.reduce((total, upload) => total + upload.size, inFlight.bytes + size);
  if (bytes > UPLOAD_BYTES_PER_DAY) {
    let freedAt = now + 60_000;
    for (const upload of daily) {
      bytes -= upload.size;
      if (bytes <= UPLOAD_BYTES_PER_DAY) {
        freedAt = upload.createdAt + DAY;
        break;
      }
    }
    wait = Math.max(wait, freedAt - now);
  }
  return wait;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

type UploadResponse = {
  files?: Array<{ hash?: unknown; url?: unknown }>;
  errors?: Array<{ error?: unknown }>;
  error?: unknown;
};

/** Talks to teacup with Lingo's credentials; nothing it returns exposes them or teacup's internal URL. */
export class TeacupClient {
  private readonly authorization: string;
  private cached: { value: TeacupCapabilities; expiresAt: number } | null = null;
  private pending: Promise<TeacupCapabilities | null> | null = null;

  constructor(readonly config: UploadConfig, private readonly now: () => number = Date.now) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }

  get maxBytes(): number {
    return this.config.maxBytes;
  }

  /** teacup's current limits, cached for its `max-age` (1–10 minutes); null when unreachable or incompatible. */
  capabilities(): Promise<TeacupCapabilities | null> {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.value);
    this.pending ??= this.fetchCapabilities().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Forgets cached capabilities, so the next request asks teacup again. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchCapabilities(): Promise<TeacupCapabilities | null> {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`${this.config.url}/api/capabilities`, { signal: AbortSignal.timeout(5000) });
      body = response.ok ? await response.json() : null;
    } catch (error) {
      console.error('Upload service capabilities unavailable:', error instanceof Error ? error.message : error);
      return null;
    }
    if (!response.ok) {
      console.error(`Upload service capabilities returned ${response.status}; teacup needs GET /api/capabilities`);
      return null;
    }
    const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const { apiVersion, maxFileSizeBytes, maxTtlSeconds, permanentAllowed } = value;
    if (apiVersion !== 1) {
      console.error(`Upload service reports unsupported apiVersion ${JSON.stringify(apiVersion)}`);
      return null;
    }
    if (typeof maxFileSizeBytes !== 'number' || !(maxFileSizeBytes > 0) || typeof permanentAllowed !== 'boolean' ||
      (maxTtlSeconds !== null && (typeof maxTtlSeconds !== 'number' || !(maxTtlSeconds > 0)))) {
      console.error('Upload service returned malformed capabilities');
      return null;
    }
    const capabilities = { maxFileSizeBytes, maxTtlSeconds, permanentAllowed };
    const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 60);
    this.cached = { value: capabilities, expiresAt: this.now() + Math.min(600, Math.max(60, maxAge)) * 1000 };
    return capabilities;
  }

  /** Stores one file; resolves to teacup's id and the public link. Rejects with `UploadError`, or the abort reason. */
  async upload(file: Blob, filename: string, expiry: UploadExpiry, signal: AbortSignal): Promise<{ hash: string; url: string }> {
    try {
      return await this.send(file, filename, expiry, signal);
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  private async send(file: Blob, filename: string, expiry: UploadExpiry, signal: AbortSignal) {
    const form = new FormData();
    form.append('file', file, filename);
    if (expiry === 'permanent') form.append('permanent', 'true');
    else form.append('ttl_seconds', String(EXPIRY_SECONDS[expiry]));
    let response: Response;
    let body: UploadResponse | null;
    try {
      response = await fetch(`${this.config.url}/upload`, {
        method: 'POST',
        headers: { Authorization: this.authorization },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      body = await response.json().catch(() => null) as UploadResponse | null;
    } catch (error) {
      if (signal.aborted && isAbort(signal.reason)) throw signal.reason;
      console.error('Upload service request failed:', error instanceof Error ? error.message : error);
      throw new UploadError('Upload service unavailable', 502);
    }
    if (response.status === 401 || response.status === 403) {
      console.error(`Upload service rejected Lingo's credentials (${response.status})`);
      throw new UploadError('Upload service rejected Lingo’s credentials', 502);
    }
    const rejection = body?.errors?.[0]?.error ?? body?.error;
    if (response.status >= 500 || !body) {
      console.error(`Upload service failed (${response.status}):`, typeof rejection === 'string' ? rejection : 'no details');
      throw new UploadError('Upload service unavailable', 502);
    }
    const files = Array.isArray(body.files) ? body.files : [];
    if (!response.ok || files.length !== 1) {
      if (typeof rejection === 'string' && rejection) throw new UploadError(rejection.slice(0, 300), 422);
      console.error(`Upload service returned ${response.status} with ${files.length} files and no error`);
      throw new UploadError('Upload failed', 502);
    }
    const [{ hash, url }] = files as [{ hash?: unknown; url?: unknown }];
    let path: string | undefined;
    try {
      path = typeof url === 'string' ? new URL(url).pathname : undefined;
    } catch {
      path = undefined;
    }
    const match = path ? PATH_PATTERN.exec(path) : null;
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || match?.[1] !== hash) {
      console.error('Upload service returned an unexpected file link');
      throw new UploadError('Upload failed', 502);
    }
    return { hash, url: `${this.config.publicUrl}${path}` };
  }

  /** Deletes a file; one teacup no longer has (expired or already removed) counts as deleted. */
  async remove(hash: string): Promise<void> {
    if (!HASH_PATTERN.test(hash)) throw new Error('Invalid upload id');
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/api/files/${hash}`, {
        method: 'DELETE',
        headers: { Authorization: this.authorization },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
    } catch (error) {
      console.error('Upload service delete failed:', error instanceof Error ? error.message : error);
      throw new UploadError('Upload service unavailable', 502);
    }
    if (response.ok || response.status === 404) return;
    console.error(`Upload service delete returned ${response.status}`);
    throw new UploadError('Upload service unavailable', 502);
  }
}
