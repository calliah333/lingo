# Lingo agent guide

Lingo is a Bun/TypeScript IRC client: React 19 and Vite in the browser, Hono on Bun for HTTP/WebSocket APIs, `irc-framework` for IRC, and SQLite (including FTS5) for persistent history. Read the relevant source before changing behavior; this file is a map, not a replacement for the code.

## Layout

- `src/client/main.tsx` mounts the app. `App.tsx` owns authentication, network/buffer selection, unread counts, WebSocket catch-up, search/navigation, topic and roster state, and sidebar interactions. `MentionComposer.tsx`, `Transcript.tsx`, `SearchPanel.tsx`, `NetworkSettings.tsx`, and `ThemePicker.tsx` own their respective UI. Shared responsive/theme styling is in `src/client/styles.css`.
- `src/shared/contracts.ts` defines API/WebSocket payloads and the network, buffer, message, and channel-state types used by both sides. `src/shared/identity.ts` handles relay/display identities and mention matching. Update both producers and consumers when changing a contract.
- `src/server/index.ts` creates the store, IRC manager, Hono app, WebSocket server, and production static-file serving. `app.ts` contains authenticated routes, Zod input validation, session/origin checks, and event publication. `irc.ts` owns IRC connections, commands, joins, topics, live users/ranks, and event-to-history translation. `store.ts` owns SQLite migrations, buffers, history, sessions, and FTS search. `irc-framework.d.ts` declares the subset of the library API this project uses.
- `tests/auth.test.ts`, `identity.test.ts`, `migration.test.ts`, and `irc.test.ts` cover auth, identity matching, schema migration, and IRC/history behavior. `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`, and `bun.lock` are the app/build configuration.

## Running and checking

- `bun install` installs dependencies. `bun run dev` starts the Bun server with watch mode and Vite; Vite proxies `/api` (including WebSockets) to `127.0.0.1:3000`.
- `bun run build` builds the browser into ignored `dist/` and runs `tsc --noEmit`. `bun test` runs the Bun test suite. `bun run start` serves the built frontend and API from Bun; build first if `dist/` does not exist.
- `LINGO_PASSWORD` is required. Optional runtime settings: `LINGO_HOST` (default `127.0.0.1`), `LINGO_PORT` (default `3000`), `LINGO_DB_PATH` (default `local/lingo.sqlite`), and `LINGO_PUBLIC_ORIGIN` (an exact HTTPS origin when set). `.env`, `local/`, `dist/`, and SQLite files are local/generated data; do not overwrite or commit secrets or a user's database. Use a temporary database and a mock IRC peer for end-to-end checks.

## Behavioral invariants

- `/api/bootstrap` supplies networks, buffers, and statuses. `/api/events` pushes typed `ServerEvent`s; the client also fetches message pages and catches up after reconnect. Keep event handling, REST results, and `src/shared/contracts.ts` in sync.
- The persisted `server` buffer is opened by clicking its network heading, not by a duplicate sidebar row. Channel `DELETE /api/buffers/:id` parts the channel **without deleting its history**. Closing a PM in the UI only hides it locally so history survives; the query-buffer DELETE route removes its stored buffer/history and must not be used for that UI action. Hidden buffers and collapsed networks are browser-local state.
- Channel topics and ranked rosters are live IRC state exposed by `GET /api/buffers/:id/channel` and `channel_state` events. A `null` topic is not yet known; `''` means the server reports no topic. Topic edits go through `PATCH /api/buffers/:id/topic` and become authoritative when IRC reports the change. IRC rank symbols come from the server's PREFIX mapping, not a fixed nickname prefix.
- `POST /api/buffers/batch` joins validated distinct channels; `/join` also accepts multiple channel names. `/list` writes bounded channel-list results into the network's server buffer. Slash suggestions in `MentionComposer.tsx` should list only commands supported by `IrcManager.sendText`.
- Search uses SQLite FTS5 in `Store.searchMessages`; its network/buffer and inclusive time filters must also apply to pagination. Relay nickname parsing, display-name overrides, and mention aliases belong to shared identity logic, not ad hoc transcript rewrites.
- Preserve migrations and existing messages when changing storage. Keep input validation and same-origin/session protection on new API routes. For UI changes, run the build/typecheck and exercise the actual browser surface; for IRC protocol changes, exercise a mock peer as well as `bun test`.
