export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
    throw new ApiError(typeof error === 'string' ? error : `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

export function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/** A 401 that ended the session; a wrong current password during a password change is also a 401 but keeps it. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.message !== 'Invalid password';
}
