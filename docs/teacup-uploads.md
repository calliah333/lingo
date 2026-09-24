# Uploading files to teacup

Let Lingo users attach files (from a file picker, paste, or drag-and-drop), upload them to the self-hosted teacup instance (`../teacup`), and insert the returned link into the message box. Lingo never renders the uploaded content: the link is ordinary message text.

## What teacup provides (`../teacup/main.go`)

| Item | Behaviour | Where |
|---|---|---|
| Upload | `POST /upload`, multipart field `file` (or `files`), several files allowed | `uploadHandler` L1025 |
| Auth | HTTP Basic with the single `USERNAME`/`PASSWORD` from teacup's `.env`, or its session cookie, or 5-minute temporary credentials | `requireAuth` L410, `loadCredentials` L64 |
| Expiry | `permanent=true`, or `ttl_seconds=<n>`; otherwise the **3 h default** | L1069–1089, `main` L1469 |
| Response | `200 {success:true, files:[{hash, filename, extension, url}], errors?:[{filename, error}]}` | L1196–1207 |
| Returned URL | Built from the request's `Host` header and `X-Forwarded-Proto`; the file id is 8 hex characters from `sha256(filename+time)` | `absoluteURL` L1017, `generateHash` L343 |
| Size and limits | `MAX_FILE_SIZE_MB` (default 100). Today `GET /config` returns only `{maxFileSizeBytes}`; [teacup PLAN.md](../../teacup/PLAN.md) item 5 replaces it with `GET /api/capabilities` (size, files per request, default/max expiry, whether permanent files are allowed) | L26, `configHandler` L537 |
| Delete | `DELETE /api/files/<hash>` (authenticated) | `deleteFileHandler` L631 |
| Serving | `image/*` served inline, everything else as an attachment | `downloadHandler` L1279 |
| CORS | None | — |

Consequences for Lingo:
1. **Uploads go through the Lingo server.** teacup has no CORS support, and its single set of credentials must never reach browsers. Lingo authenticates the user, checks their permission and limits, and calls teacup with Basic auth itself.
2. **Handle partial failures.** teacup returns 200 with an empty `files` array when a file failed. The failure may appear in `errors`, or nowhere at all (a failed record save does a bare `continue`, L1169–1181). Lingo counts anything other than exactly one returned file as a failure.
3. **Rewrite the returned URL.** If Lingo reaches teacup at an internal address (e.g. `http://127.0.0.1:8080` or a Docker service name), the returned `url` contains that internal host. Lingo builds the public link itself from a configured public base URL plus the returned path.
4. **Choose the expiry explicitly.** teacup's 3 h default is too short for links in IRC logs. Lingo always sends `ttl_seconds` or `permanent`.
5. **Clean the filename first.** teacup uses the original filename's extension in the URL (`filepath.Ext`), so a name like `a.b c` would put a space into the link. Lingo cleans the name before forwarding it.

## Configuration

Environment variables, which keep the secret out of SQLite and the UI:

| Variable | Meaning |
|---|---|
| `LINGO_TEACUP_URL` | The base URL Lingo calls, e.g. `http://127.0.0.1:8080`. When unset, the feature is off: routes return 404 and the UI hides the attach button. |
| `LINGO_TEACUP_USERNAME`, `LINGO_TEACUP_PASSWORD` | The teacup credentials. Required when the URL is set; startup fails otherwise. |
| `LINGO_TEACUP_PUBLIC_URL` | The public base for links posted to IRC (must be `https:` unless the host is localhost). Defaults to `LINGO_TEACUP_URL`. |
| `LINGO_UPLOAD_MAX_MB` | Lingo's own limit, default 25. The effective limit is the smaller of this and teacup's `maxFileSizeBytes` from `/api/capabilities`. |

`index.ts` validates these the same way it validates `LINGO_PUBLIC_ORIGIN`, and sets Bun's `maxRequestBodySize` to the effective limit plus 1 MiB of multipart overhead.

## Permissions and limits

- Migration: `users.can_upload INTEGER NOT NULL DEFAULT 0`, set to 1 for the admin row. The admin toggles it per user via `PATCH /api/users/:id { canUpload }`. That route comes from roadmap item 2.1; if uploads are built first, add the route here with only this field. `AccountUser` gains `canUpload`, so the client knows whether to show the attach button.
- Limits per user, reusing the limiter from roadmap 1.1 (or a small one here if 1.1 isn't built yet): 30 uploads per hour and 500 MB per day (tracked with the `uploads` table below). Over the limit returns 429 with `Retry-After`.

## Storage

Migration: `uploads (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, teacup_hash TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NULL /* NULL = permanent */, created_at INTEGER NOT NULL)`, with an index on `(user_id, created_at)`. This table records who uploaded what, supplies the daily byte count, and lets users delete their own uploads without access to teacup's admin UI.

## Server

New file `src/server/uploads.ts`, containing a `TeacupClient` built from the config (so tests can point it at a fake server):
- `upload(file: File, filename: string, expiry: Expiry, signal): Promise<{ hash, url }>`:
  - Build a `FormData` with `file` plus either `permanent=true` or `ttl_seconds`, and `fetch(`${base}/upload`, { method: 'POST', headers: { Authorization: 'Basic …' }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })`.
  - Map responses to errors:
    - 401 or 403: `UploadError('Upload service rejected Lingo's credentials')`, logged server-side.
    - Other non-2xx, or invalid JSON: `UploadError('Upload service unavailable')`.
    - `files.length !== 1`: `UploadError(errors?.[0]?.error ?? 'Upload failed')`.
  - Check the returned path against `^/[0-9a-z]{8,64}\.[A-Za-z0-9]{1,10}$` (this accepts today's 8-hex ids and the 26-character base32 ids from teacup PLAN.md item 4), then return `publicBase + path`.
- `remove(hash)`: `DELETE /api/files/<hash>`. A 404 counts as success (the file already expired).
- `capabilities()`: `GET /api/capabilities`, cached for teacup's `Cache-Control: max-age` (at least 60 s, at most 10 min) and fetched again after a failed upload. If `apiVersion !== 1`, or the route is missing (an older teacup still serving only `/config`), log it and treat uploads as unavailable instead of guessing the limits. **Prerequisite:** teacup PLAN.md item 5.
- The expiry choices Lingo offers come from the capabilities: Lingo's presets (`1h | 1d | 7d | 30d`) above `maxTtlSeconds` are dropped, `permanent` is offered only when `permanentAllowed` is true, and a request for an expiry that isn't offered is rejected with 400.

Routes in `app.ts`. All require a session and the same-origin check. When uploads aren't configured, every route except capabilities returns 404.
- `GET /api/uploads/capabilities`: what this user may upload right now, computed on the server from the env config, the user's `canUpload` flag, and teacup's capabilities: `{ enabled: true, maxBytes, expiries: UploadExpiry[], defaultExpiry }`, or `{ enabled: false, reason: 'not_configured' | 'not_permitted' | 'unavailable' }`. It always returns 200, so the client needs no special error handling to decide whether to show the attach button. `maxBytes` is the effective limit (the smaller of Lingo's and teacup's). `defaultExpiry` is `7d`, or the longest allowed expiry if that is shorter.
- `POST /api/uploads`: a multipart body with one `file` and an `expiry` from the capabilities' `expiries` list.
  - Checks in order: `canUpload` (403), `Content-Length` against the limit (413, before reading the body), `c.req.formData()`, exactly one `File` (400), `file.size` (413), rate limits (429).
  - Clean the filename: take the basename, keep `[A-Za-z0-9._-]`, cap it at 100 characters, and keep an extension only if it matches `[A-Za-z0-9]{1,10}`. When nothing usable remains, use `upload.bin`, or pick an extension from the MIME type for pasted images, e.g. `paste.png`.
  - Call `upload()` with the request's abort signal, insert a row in `uploads`, and return `201 { id, url, filename, size, expiresAt }`.
  - Errors return `{ error }` with 502 for service failures or 422 for teacup's per-file errors. Credentials and teacup's internal URL never appear in responses.
- `GET /api/uploads`: the current user's uploads that haven't expired, newest first, paged with `before`/`limit`.
- `DELETE /api/uploads/:id`: owner only (404 otherwise). Calls `remove()`, then deletes the row.
- When the admin deletes a user (`DELETE /api/users/:id`), try to `remove()` that user's uploads that haven't expired before deleting the user; log failures and continue.

Contracts (`src/shared/contracts.ts`): `UploadExpiry = '1h' | '1d' | '7d' | '30d' | 'permanent'`, `UploadCapabilities` (the union above), and `UploadRecord { id; url; filename; size; expiresAt: number | null; createdAt }`. Nothing is added to `Bootstrap`: the client fetches capabilities after bootstrap and again when Settings opens.

## Client

- `MentionComposer.tsx`: an attach button next to the message box (hidden unless the capabilities say `enabled`), a hidden `<input type="file" multiple>`, `onPaste` handling of `clipboardData.files` (screenshots), and drag-and-drop onto the conversation pane (handled in `App.tsx` and passed down).
- The upload itself uses `XMLHttpRequest`, which reports upload progress (`fetch` doesn't). The message box shows a small bar with the filename, percentage, and a Cancel button (`xhr.abort()`; the server aborts its teacup request through the request signal). Multiple files upload one after another.
- On success, insert the URL at the caret followed by a space. **Never send automatically**: the user sends the message themselves. Show errors in the existing `onError` notice.
- Expiry: a small selector next to the attach button listing only the capabilities' `expiries`. The device preference `uploadExpiry` in `preferences.ts` is used when it's in the list; otherwise the capabilities' `defaultExpiry`.
- Settings gains an "Uploads" section: a list from `GET /api/uploads` (filename, size, expiry, copy link, delete). Admins get a "Can upload" toggle for each user in the Users section.
- Files larger than the capabilities' `maxBytes` are rejected in the browser before uploading; the server checks again. If an upload fails with 400/413 because the limits changed, fetch the capabilities again.

## Tests (`tests/uploads.test.ts`)

Start a fake teacup with `Bun.serve` on port 0 that records requests. Cover:
- A successful upload sends Basic auth, exactly one `file` part, and `ttl_seconds` for `7d` or `permanent=true`; the response URL uses `LINGO_TEACUP_PUBLIC_URL` and a clean path; an `uploads` row is written.
- The filename is cleaned: `../../a b.p!ng` becomes a name with a safe extension.
- An oversized body returns 413 and the fake teacup receives nothing.
- A user without `canUpload` gets 403 from `POST`. With the feature off, the upload routes return 404.
- Capabilities: `not_configured` when the env vars are unset, `not_permitted` without `canUpload`, `unavailable` when the fake teacup is down or reports `apiVersion: 2`. `maxBytes` is the smaller of the two limits. `permanent` and long expiries disappear when the fake teacup disallows them, and uploading with an expiry that isn't offered returns 400.
- teacup answering 200 with `files: []` and `errors` returns 422 with teacup's message. `files: []` with no errors returns 502. A teacup 401 returns 502, and the response body contains neither the password nor the internal URL.
- Deleting another user's upload returns 404. Deleting your own calls `DELETE /api/files/<hash>` and removes the row; a teacup 404 still removes the row.
- The rate limit returns 429 after 30 uploads.

End-to-end check: run teacup locally (`cd ../teacup && go run .` with a temporary `.env` and `UPLOAD_DIR`), start Lingo with the variables above and a temporary database, then paste a screenshot in the browser. The link should be inserted without being sent; opening it serves the file from teacup; deleting it from Settings makes the link 404.

## teacup changes

The teacup changes are planned in teacup's own repo: [../teacup/PLAN.md](../../teacup/PLAN.md). They cover inline SVG/HTML serving, the password in the startup log, non-constant-time credential checks, guessable ids, silent upload failures, request memory limits, and the capabilities API. Item 5 (`GET /api/capabilities`) is a **prerequisite** for this plan. The others make teacup links safer to share but Lingo doesn't depend on them.
