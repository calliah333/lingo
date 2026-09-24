# Lingo roadmap

Planned features, in the order they should be built. Each item says why it exists, how it should work, which files it touches, and how to verify it. Nothing is planned right now: every item so far has been built, the last being file uploads to the self-hosted teacup instance.

Out of scope, by decision: link previews, inline images, and any other fetching or embedding of third-party content.

Current baseline: schema `user_version = 14` includes per-user networks and sessions, account limits and the admin-granted upload permission (`users.can_upload`), synced user settings, server-backed read markers, unread counts, and highlights, Web Push subscriptions, per-buffer IRCv3 message ids (`messages.msgid`, unique per buffer; `Store.appendUniqueMessage` returns null for a duplicate), the per-network `networks.backfill` chathistory toggle, per-network connect options (`networks.join_delay_seconds`, `networks.regain_nick`), and the `uploads` record of files sent to teacup. Appearance, the upload expiry choice, and browser notification choices remain in `localStorage`; mutes, hidden buffers, collapsed networks, highlight phrases, `pushIncludesText`, and `sendTyping` are synced. `public/` holds the web manifest, icons, the SVG favicon, and the push service worker (`sw.js`). `ircFormat.tsx` renders `http(s)://` URLs as `nofollow`/`no-referrer` links with no fetching or previews; uploaded files are only ever such links.

## Conventions for every item

- Storage changes add one migration step in `Store.migrate()` (bump `user_version` by one) and extend `tests/migration.test.ts` with an upgrade from the previous version. Never rewrite an earlier migration.
- New routes keep Zod validation, the same-origin check, session auth, and ownership checks (`ownsNetwork`/`ownedBuffer`). Admin routes live under `/api/users*` so the existing admin guard in the middleware applies.
- Contract changes go in `src/shared/contracts.ts` first, then update both the server and the client.
- Definition of done: `bun run build` and `bun test` pass; UI changes are exercised in a real browser; IRC changes are exercised against a mock peer (reuse the servers in `tests/irc.test.ts`); `AGENTS.md` is updated when invariants change.

Built so far: Phase 4 (installable app with Web Push), Phase 5 (IRCv3: msgid storage with echo-message, chathistory backfill, and `+typing` indicators), Phase 6 (streamed history export per buffer as text or JSONL and per network as JSONL), Phase 7 (unread state in the tab title and favicon; buffer keyboard navigation, the Ctrl/Cmd+K quick switcher, and a Keyboard settings tab; per-network join delay and NickServ REGAIN of a taken nick), and teacup uploads (attach, paste, or drop files; the link is inserted into the composer, never sent automatically; per-user permission, limits, and an Uploads settings tab).
