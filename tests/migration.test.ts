import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { NetworkLimitReached, Store } from '../src/server/store.ts';

test('migrates a v1 database without losing networks, history, or indexed search', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, 'legacy.sqlite');
  let store: Store | undefined;
  try {
    const legacy = new Database(path, { create: true });
    try {
      // The original v1 schema, including its external-content FTS5 index and triggers.
      legacy.exec(`
        CREATE TABLE networks (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          tls INTEGER NOT NULL,
          nick TEXT NOT NULL,
          username TEXT NOT NULL,
          realname TEXT NOT NULL,
          sasl_account TEXT NOT NULL,
          sasl_password TEXT NOT NULL,
          autojoin TEXT NOT NULL,
          commands TEXT NOT NULL
        );
        CREATE TABLE buffers (
          id INTEGER PRIMARY KEY,
          network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('server', 'channel', 'query')),
          UNIQUE(network_id, kind, name_key),
          UNIQUE(id, network_id)
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          network_id INTEGER NOT NULL,
          buffer_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('privmsg', 'notice', 'action', 'system')),
          nick TEXT,
          text TEXT NOT NULL,
          time INTEGER NOT NULL,
          FOREIGN KEY (buffer_id, network_id) REFERENCES buffers(id, network_id) ON DELETE CASCADE
        );
        CREATE INDEX messages_buffer_history ON messages(buffer_id, id DESC);
        CREATE INDEX messages_network_history ON messages(network_id, id DESC);
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX sessions_expiration ON sessions(expires_at);
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, nick, content='messages', content_rowid='id');
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text, nick) VALUES (new.id, new.text, new.nick);
        END;
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, nick)
            VALUES ('delete', old.id, old.text, old.nick);
        END;
        CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, nick)
            VALUES ('delete', old.id, old.text, old.nick);
          INSERT INTO messages_fts(rowid, text, nick) VALUES (new.id, new.text, new.nick);
        END;
      `);
      legacy.query(`
        INSERT INTO networks (id, name, host, port, tls, nick, username, realname,
                              sasl_account, sasl_password, autojoin, commands)
        VALUES (7, 'Old IRC', 'irc.example.test', 6697, 1, 'oldnick', 'olduser',
                'Old User', 'account', 'legacy-secret', '["#chat"]', '["MODE +i"]')
      `).run();
      legacy.query(`
        INSERT INTO buffers (id, network_id, name, name_key, kind)
        VALUES (13, 7, '#chat', '#chat', 'channel')
      `).run();
      legacy.query(`
        INSERT INTO messages (id, network_id, buffer_id, kind, nick, text, time)
        VALUES (29, 7, 13, 'privmsg', 'alice', 'historic lighthouse message', 1700000000000)
      `).run();
      legacy.query(`
        INSERT INTO messages (id, network_id, buffer_id, kind, nick, text, time)
        VALUES (30, 7, 13, 'action', 'bob', 'waves hello', 1700000001000)
      `).run();
      legacy.query('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run('a'.repeat(64), 9e12);
      legacy.exec('PRAGMA user_version = 1');
    } finally {
      legacy.close();
    }

    const oldMessage = {
      id: 29, networkId: 7, bufferId: 13, kind: 'privmsg' as const,
      nick: 'alice', text: 'historic lighthouse message', time: 1700000000000,
    };
    const nextMessage = {
      id: 30, networkId: 7, bufferId: 13, kind: 'action' as const,
      nick: 'bob', text: 'waves hello', time: 1700000001000,
    };
    const oldNetwork = {
      id: 7, name: 'Old IRC', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'oldnick', username: 'olduser', realname: 'Old User', saslAccount: 'account',
      autojoin: ['#chat'], commands: ['MODE +i'], relayNicks: [], mentionAliases: [],
      displayNames: {},
    };

    store = new Store(path);
    expect(store.listNetworks()).toEqual([oldNetwork]);
    // Without a stored password hash the legacy account becomes an unclaimed admin that
    // owns the existing data, and sessions created under the old shared password are dropped.
    expect(store.setupRequired()).toBe(true);
    expect(store.sessionUser('a'.repeat(64), 0)).toBeNull();
    const admin = store.claimAdmin('root', 'scrypt:claimed');
    expect(admin).toMatchObject({ username: 'root', isAdmin: true });
    expect(store.claimAdmin('other', 'scrypt:second')).toBeNull();
    expect(store.listNetworks(admin!.id)).toEqual([oldNetwork]);
    expect(store.listBuffers(admin!.id)).toHaveLength(1);
    expect(store.getNetworkConfig(7)?.saslPassword).toBe('legacy-secret');
    expect(store.listBuffers()).toEqual([{ id: 13, networkId: 7, name: '#chat', kind: 'channel' }]);
    expect(store.getMessages(13)).toEqual({ messages: [oldMessage, nextMessage], hasMore: false });
    expect(store.searchMessages('lighthouse', { networkId: 7, bufferId: 13 })).toEqual({
      messages: [oldMessage], hasMore: false,
    });

    const updatedNetwork = {
      ...oldNetwork,
      relayNicks: ['bridgebot'],
      mentionAliases: ['anothernick'],
      displayNames: { alice: 'Alice A.' },
    };
    expect(store.updateNetwork(7, { ...updatedNetwork, saslPassword: '' })).toEqual(updatedNetwork);
    store.close();
    store = undefined;

    store = new Store(path);
    expect(store.getNetwork(7)).toEqual(updatedNetwork);
    expect(store.getNetworkConfig(7)?.saslPassword).toBe('legacy-secret');
    expect(store.getMessages(13)).toEqual({ messages: [oldMessage, nextMessage], hasMore: false });
    expect(store.searchMessages('lighthouse', { networkId: 7, bufferId: 13 })).toEqual({
      messages: [oldMessage], hasMore: false,
    });
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('migrates a v4 database password and sessions into the admin account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, 'v4.sqlite');
  let store: Store | undefined;
  try {
    const legacy = new Database(path, { create: true });
    try {
      legacy.exec(`
        CREATE TABLE networks (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, host TEXT NOT NULL,
          port INTEGER NOT NULL, tls INTEGER NOT NULL, nick TEXT NOT NULL, username TEXT NOT NULL,
          realname TEXT NOT NULL, sasl_account TEXT NOT NULL, sasl_password TEXT NOT NULL,
          autojoin TEXT NOT NULL, commands TEXT NOT NULL, relay_nicks TEXT NOT NULL DEFAULT '[]',
          mention_aliases TEXT NOT NULL DEFAULT '[]', display_names TEXT NOT NULL DEFAULT '{}',
          disconnected INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE buffers (
          id INTEGER PRIMARY KEY,
          network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
          name TEXT NOT NULL, name_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('server', 'channel', 'query')),
          UNIQUE(network_id, kind, name_key), UNIQUE(id, network_id)
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY, network_id INTEGER NOT NULL, buffer_id INTEGER NOT NULL,
          kind TEXT NOT NULL, nick TEXT, text TEXT NOT NULL, time INTEGER NOT NULL,
          from_network INTEGER NOT NULL DEFAULT 0, connection_event TEXT, is_motd INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (buffer_id, network_id) REFERENCES buffers(id, network_id) ON DELETE CASCADE
        );
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE account_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT, away_message TEXT NOT NULL DEFAULT 'Away'
        );
        CREATE TABLE ignores (
          network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
          nick TEXT NOT NULL, nick_key TEXT NOT NULL, PRIMARY KEY (network_id, nick_key)
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, nick, content='messages', content_rowid='id');
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text, nick) VALUES (new.id, new.text, new.nick);
        END;
        INSERT INTO account_settings (id, password_hash, away_message) VALUES (1, 'scrypt:legacy', 'Gone fishing');
        INSERT INTO networks (id, name, host, port, tls, nick, username, realname, sasl_account,
                              sasl_password, autojoin, commands, disconnected)
          VALUES (3, 'Net', 'irc.example.test', 6697, 1, 'me', 'me', 'Me', '', '', '[]', '[]', 1);
        INSERT INTO buffers (id, network_id, name, name_key, kind) VALUES (5, 3, '#room', '#room', 'channel');
        INSERT INTO messages (id, network_id, buffer_id, kind, nick, text, time) VALUES (8, 3, 5, 'privmsg', 'bob', 'kept', 1);
        INSERT INTO ignores (network_id, nick, nick_key) VALUES (3, 'Spammer', 'spammer');
      `);
      legacy.query('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)').run('b'.repeat(64), 9e12, 1);
      legacy.exec('PRAGMA user_version = 4');
    } finally {
      legacy.close();
    }

    store = new Store(path);
    expect(store.setupRequired()).toBe(false);
    const admin = store.sessionUser('b'.repeat(64), 0);
    expect(admin).toMatchObject({ username: 'admin', isAdmin: true });
    expect(store.getCredentials('ADMIN')?.passwordHash).toBe('scrypt:legacy');
    expect(store.getAwayMessage(admin!.id)).toBe('Gone fishing');
    expect(store.listNetworks(admin!.id).map(network => network.id)).toEqual([3]);
    expect(store.isNetworkDisconnected(3)).toBe(true);
    expect(store.allIgnores(admin!.id)).toEqual({ 3: ['Spammer'] });
    expect(store.searchMessages('kept', { userId: admin!.id }).messages.map(message => message.id)).toEqual([8]);

    // Removing a user cascades through their networks to buffers and history.
    const other = store.createUser('bob', 'scrypt:bob')!;
    const otherNetwork = store.createNetwork(other.id, { ...store.getNetwork(3)!, saslPassword: '' });
    const otherBuffer = store.getOrCreateBuffer(otherNetwork.id, '#room', 'channel');
    store.appendMessage({ networkId: otherNetwork.id, bufferId: otherBuffer.id, kind: 'privmsg', nick: 'x', text: 'kept', time: 2 });
    store.removeUser(other.id);
    expect(store.getBuffer(otherBuffer.id)).toBeNull();
    expect(store.searchMessages('kept', {}).messages.map(message => message.id)).toEqual([8]);
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

for (const version of [5, 6]) {
test(`migrates v${version} accounts in place while retaining networks and messages`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, `v${version}.sqlite`);
  let store: Store | undefined;
  try {
    const legacy = new Database(path, { create: true });
    try {
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (
          id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
          away_message TEXT NOT NULL DEFAULT 'Away', created_at INTEGER NOT NULL,
          CHECK (is_admin = 1 OR password_hash IS NOT NULL)
        );
        CREATE UNIQUE INDEX users_single_admin ON users(is_admin) WHERE is_admin = 1;
        CREATE TABLE networks (
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL COLLATE NOCASE, host TEXT NOT NULL, port INTEGER NOT NULL,
          tls INTEGER NOT NULL, nick TEXT NOT NULL, username TEXT NOT NULL, realname TEXT NOT NULL,
          sasl_account TEXT NOT NULL, sasl_password TEXT NOT NULL, autojoin TEXT NOT NULL,
          commands TEXT NOT NULL, relay_nicks TEXT NOT NULL DEFAULT '[]',
          mention_aliases TEXT NOT NULL DEFAULT '[]', display_names TEXT NOT NULL DEFAULT '{}',
          disconnected INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, name)
        );
        CREATE TABLE buffers (
          id INTEGER PRIMARY KEY, network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
          name TEXT NOT NULL, name_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('server', 'channel', 'query')),
          UNIQUE(network_id, kind, name_key), UNIQUE(id, network_id)
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY, network_id INTEGER NOT NULL, buffer_id INTEGER NOT NULL,
          kind TEXT NOT NULL, nick TEXT, text TEXT NOT NULL, time INTEGER NOT NULL,
          from_network INTEGER NOT NULL DEFAULT 0, connection_event TEXT, is_motd INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (buffer_id, network_id) REFERENCES buffers(id, network_id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, nick, content='messages', content_rowid='id');
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text, nick) VALUES (new.id, new.text, new.nick);
        END;
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX sessions_expiration ON sessions(expires_at);
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE TABLE ignores (
          network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
          nick TEXT NOT NULL, nick_key TEXT NOT NULL, PRIMARY KEY (network_id, nick_key)
        );
        INSERT INTO users (id, username, password_hash, is_admin, created_at)
          VALUES (1, 'admin', 'scrypt:admin', 1, 100), (2, 'alice', 'scrypt:alice', 0, 200);
        INSERT INTO networks (id, user_id, name, host, port, tls, nick, username, realname,
                              sasl_account, sasl_password, autojoin, commands, disconnected)
          VALUES (3, 2, 'Old IRC', 'irc.example.test', 6697, 1, 'alice', 'alice', 'Alice',
                  '', '', '[]', '[]', 0),
                 (4, 2, 'Other IRC', 'irc.other.test', 6667, 0, 'alice', 'alice', 'Alice',
                  '', '', '[]', '[]', 1);
        INSERT INTO buffers (id, network_id, name, name_key, kind) VALUES (5, 3, '#room', '#room', 'channel');
        INSERT INTO messages (id, network_id, buffer_id, kind, nick, text, time)
          VALUES (8, 3, 5, 'privmsg', 'bob', 'historic lighthouse', 300);
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
          VALUES ('live', 2, 1000, 400), ('expired', 2, 500, 300);
        PRAGMA user_version = 5;
      `);
      if (version === 6) {
        legacy.exec(`
          ALTER TABLE users ADD COLUMN last_login_at INTEGER;
          ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));
          UPDATE users SET last_login_at = 450 WHERE id = 2;
          PRAGMA user_version = 6;
        `);
      }
    } finally {
      legacy.close();
    }

    store = new Store(path);
    expect(store.listAdminUsers(500)).toEqual([
      {
        id: 1, username: 'admin', isAdmin: true, createdAt: 100, disabled: false,
        lastLoginAt: null, networkCount: 0, sessionCount: 0, maxNetworks: null, retentionDays: null,
      },
      {
        id: 2, username: 'alice', isAdmin: false, createdAt: 200, disabled: false,
        lastLoginAt: version === 6 ? 450 : null, networkCount: 2, sessionCount: 1,
        maxNetworks: null, retentionDays: null,
      },
    ]);
    expect(store.listNetworks(2).map(network => network.id)).toEqual([3, 4]);
    expect(store.isNetworkDisconnected(4)).toBe(true);
    expect(store.getMessages(5).messages.map(message => message.text)).toEqual(['historic lighthouse']);
    expect(store.searchMessages('lighthouse', { userId: 2 }).messages.map(message => message.id)).toEqual([8]);
    expect(store.sessionUser('live', 500)?.id).toBe(2);

    store.createSession('new', 2, 2000, 600);
    expect(store.listAdminUsers(1000)[1]).toMatchObject({ lastLoginAt: 600, sessionCount: 1 });
    store.setUserDisabled(2, true);
    expect(store.isUserDisabled(2)).toBe(true);
    expect(store.sessionUser('live', 0)).toBeNull();
    expect(store.sessionUser('new', 0)).toBeNull();
    expect(store.listAdminUsers(0)[1]).toMatchObject({ disabled: true, sessionCount: 0, networkCount: 2 });
    expect(store.isNetworkDisconnected(3)).toBe(false);
    store.close();
    store = undefined;

    store = new Store(path);
    expect(store.isUserDisabled(2)).toBe(true);
    expect(store.getMessages(5).messages.map(message => message.id)).toEqual([8]);
    store.setUserDisabled(2, false);
    expect(store.listAdminUsers(0)[1]).toMatchObject({ disabled: false, lastLoginAt: 600, networkCount: 2 });
    const migrated = new Database(path);
    try {
      expect(migrated.query('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    } finally {
      migrated.close();
    }
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
}

test('v8 migration preserves v7 user data and keeps settings unconfigured until saved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, 'v7.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    const alice = store.createUser('alice', 'scrypt:alice')!;
    const bob = store.createUser('bob', 'scrypt:bob')!;
    const network = store.createNetwork(alice.id, {
      name: 'IRC', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'alice', username: 'alice', realname: 'Alice', saslAccount: '',
      autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
    });
    const buffer = store.getOrCreateBuffer(network.id, '#room', 'channel');
    store.appendMessage({ networkId: network.id, bufferId: buffer.id, kind: 'privmsg', nick: 'bob', text: 'kept', time: 1 });
    store.close();
    store = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec(`
        DROP TABLE push_subscriptions;
        DROP TABLE server_settings;
        DROP TABLE read_markers;
        ALTER TABLE messages DROP COLUMN highlight;
        DROP TABLE user_settings;
        PRAGMA user_version = 7;
      `);
    } finally {
      legacy.close();
    }
    store = new Store(path);
    expect(store.listUsers().map(user => user.id)).toEqual([1, alice.id, bob.id]);
    expect(store.listNetworks(alice.id)).toEqual([network]);
    expect(store.getMessages(buffer.id).messages.map(message => message.text)).toEqual(['kept']);
    const defaults = {
      highlights: [], mutedBuffers: [], mutedNetworks: [], hiddenBuffers: [],
      collapsedNetworks: [], pushIncludesText: false, sendTyping: false,
    };
    expect(store.getSettingsState(alice.id)).toEqual({ settings: defaults, configured: false });
    expect(store.getSettingsState(bob.id)).toEqual({ settings: defaults, configured: false });
    expect(store.patchSettings(alice.id, {})).toEqual(defaults);
    expect(store.getSettingsState(alice.id).configured).toBe(true);
    expect(store.getSettingsState(bob.id).configured).toBe(false);
    const saved = { ...defaults, highlights: ['signal'], mutedBuffers: [buffer.id], sendTyping: true };
    expect(store.patchSettings(alice.id, {
      highlights: ['signal'], mutedBuffers: [buffer.id], sendTyping: true,
    })).toEqual(saved);
    store.close();
    store = undefined;
    store = new Store(path);
    expect(store.getSettingsState(alice.id)).toEqual({ settings: saved, configured: true });
    expect(store.getSettingsState(bob.id)).toEqual({ settings: defaults, configured: false });
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('v9 migration seeds each buffer marker at its latest v8 message and cascades deletions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, 'v8.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    const alice = store.createUser('alice', 'scrypt:alice')!;
    const bob = store.createUser('bob', 'scrypt:bob')!;
    const input = {
      name: 'IRC', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'alice', username: 'alice', realname: 'Alice', saslAccount: '',
      autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
    };
    const network = store.createNetwork(alice.id, input);
    const otherNetwork = store.createNetwork(bob.id, { ...input, nick: 'bob' });
    const channel = store.getOrCreateBuffer(network.id, '#room', 'channel');
    const empty = store.getOrCreateBuffer(network.id, '#empty', 'channel');
    const other = store.getOrCreateBuffer(otherNetwork.id, '#other', 'channel');
    store.appendMessage({ networkId: network.id, bufferId: channel.id, kind: 'privmsg',
      nick: 'someone', text: 'historical', time: 1 });
    const last = store.appendMessage({ networkId: network.id, bufferId: channel.id,
      kind: 'action', nick: 'someone', text: 'historical action', time: 2 });
    const otherLast = store.appendMessage({ networkId: otherNetwork.id, bufferId: other.id,
      kind: 'privmsg', nick: 'someone', text: 'other history', time: 3 });
    store.close();
    store = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec(`
        DROP TABLE push_subscriptions; DROP TABLE server_settings;
        DROP TABLE read_markers; ALTER TABLE messages DROP COLUMN highlight; PRAGMA user_version = 8;
      `);
    } finally {
      legacy.close();
    }
    store = new Store(path);
    expect(store.getUnread(alice.id)).toEqual({
      [channel.id]: { messages: 0, mentions: 0, lastReadId: last.id },
      [empty.id]: { messages: 0, mentions: 0, lastReadId: 0 },
    });
    expect(store.getUnread(bob.id)).toEqual({
      [other.id]: { messages: 0, mentions: 0, lastReadId: otherLast.id },
    });
    const next = store.appendMessage({ networkId: network.id, bufferId: channel.id, kind: 'privmsg',
      nick: 'someone', text: 'new mention', time: 4, highlight: true });
    expect(store.getMessages(channel.id).messages.at(-1)).toMatchObject({ id: next.id, highlight: true });
    expect(store.getUnread(alice.id)[channel.id]).toEqual({ messages: 1, mentions: 1, lastReadId: last.id });
    store.removeBuffer(channel.id);
    store.close();
    store = undefined;
    const db = new Database(path);
    try {
      expect(db.query('SELECT last_read_id FROM read_markers WHERE buffer_id = ?').get(empty.id))
        .toEqual({ last_read_id: 0 });
      expect(db.query('SELECT last_read_id FROM read_markers WHERE buffer_id = ?').get(other.id))
        .toEqual({ last_read_id: otherLast.id });
      expect(db.query('SELECT * FROM read_markers WHERE buffer_id = ?').all(channel.id)).toEqual([]);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    } finally {
      db.close();
    }
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('v10 migration adds push storage whose subscriptions follow their session and user', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-migration-'));
  const path = join(directory, 'v9.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    const alice = store.createUser('alice', 'scrypt:alice')!;
    store.createSession('phone', alice.id, Date.now() + 60_000);
    store.createSession('laptop', alice.id, Date.now() + 60_000);
    store.close();
    store = undefined;
    const legacy = new Database(path);
    try {
      legacy.exec('DROP TABLE push_subscriptions; DROP TABLE server_settings; PRAGMA user_version = 9');
    } finally {
      legacy.close();
    }

    store = new Store(path);
    const key = store.serverSetting('vapid', () => 'first');
    expect(store.serverSetting('vapid', () => 'second')).toBe(key);
    const device = (name: string) => ({ endpoint: `https://push.example.test/${name}`, p256dh: 'p', auth: 'a' });
    expect(store.savePushSubscription(alice.id, 'phone', device('phone'), 2, 1)).toBe(true);
    expect(store.savePushSubscription(alice.id, 'laptop', device('laptop'), 2, 1)).toBe(true);
    // Re-registering an existing endpoint is not a new device; a third one is over the limit.
    expect(store.savePushSubscription(alice.id, 'laptop', device('phone'), 2, 2)).toBe(true);
    expect(store.savePushSubscription(alice.id, 'laptop', device('tablet'), 2, 2)).toBe(false);
    store.deleteSession('laptop', alice.id);
    expect(store.listPushSubscriptions(alice.id)).toEqual([]);
    expect(store.savePushSubscription(alice.id, 'phone', device('phone'), 2, 3)).toBe(true);
    store.removeUser(alice.id);
    store.close();
    store = undefined;
    const db = new Database(path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM push_subscriptions').get()).toEqual({ count: 0 });
      expect(db.query('SELECT value FROM server_settings').all()).toEqual([{ value: 'first' }]);
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    } finally {
      db.close();
    }
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('read markers only advance for messages in their buffer and unread is owner-scoped', () => {
  const store = new Store(':memory:');
  try {
    const alice = store.createUser('alice', 'scrypt:alice')!;
    const bob = store.createUser('bob', 'scrypt:bob')!;
    const input = {
      name: 'IRC', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'alice', username: 'alice', realname: 'Alice', saslAccount: '',
      autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
    };
    const network = store.createNetwork(alice.id, input);
    const otherNetwork = store.createNetwork(bob.id, { ...input, nick: 'bob' });
    const channel = store.getOrCreateBuffer(network.id, '#room', 'channel');
    const query = store.getOrCreateBuffer(network.id, 'friend', 'query');
    const other = store.getOrCreateBuffer(otherNetwork.id, '#room', 'channel');
    const append = (bufferId: number, kind: 'privmsg' | 'notice' | 'system', nick: string | null,
      highlight = false, fromNetwork = false) => store.appendMessage({
      networkId: network.id, bufferId, kind, nick, text: 'message', time: Date.now(),
      highlight, fromNetwork,
    });
    const first = append(channel.id, 'privmsg', 'friend');
    append(channel.id, 'system', null);
    append(channel.id, 'notice', 'server', false, true);
    append(channel.id, 'privmsg', 'alice');
    const highlighted = append(channel.id, 'privmsg', 'friend', true);
    append(query.id, 'privmsg', 'friend');
    append(query.id, 'privmsg', 'alice');
    expect(store.getUnread(alice.id)).toEqual({
      [channel.id]: { messages: 4, mentions: 1, lastReadId: 0 },
      [query.id]: { messages: 1, mentions: 1, lastReadId: 0 },
    });
    expect(store.getUnread(bob.id)).toEqual({
      [other.id]: { messages: 0, mentions: 0, lastReadId: 0 },
    });
    expect(store.markRead(channel.id, first.id)).toBe(first.id);
    expect(store.markRead(channel.id, highlighted.id)).toBe(highlighted.id);
    expect(store.markRead(channel.id, first.id)).toBe(highlighted.id);
    expect(store.markRead(query.id, highlighted.id)).toBeNull();
    expect(store.markRead(channel.id, -1)).toBeNull();
    expect(store.getUnread(alice.id)[channel.id]).toEqual({
      messages: 0, mentions: 0, lastReadId: highlighted.id,
    });
    const after = append(channel.id, 'privmsg', 'friend', true);
    expect(store.getUnread(alice.id)[channel.id]).toEqual({
      messages: 1, mentions: 1, lastReadId: highlighted.id,
    });
    store.clearMessages(channel.id);
    expect(store.markRead(channel.id, after.id)).toBeNull();
    expect(store.getUnread(alice.id)[channel.id]?.lastReadId).toBe(highlighted.id);
  } finally {
    store.close();
  }
});

test('unread counts inspect only the most recent 1000 post-marker rows and cap at 999', () => {
  const store = new Store(':memory:');
  try {
    const owner = store.createUser('alice', 'scrypt:alice')!;
    const network = store.createNetwork(owner.id, {
      name: 'IRC', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'alice', username: 'alice', realname: 'Alice', saslAccount: '',
      autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
    });
    const channel = store.getOrCreateBuffer(network.id, '#room', 'channel');
    const windowed = store.getOrCreateBuffer(network.id, '#windowed', 'channel');
    const append = (bufferId: number, nick: string) => store.appendMessage({
      networkId: network.id, bufferId, kind: 'privmsg', nick, text: 'hello', time: 1, highlight: true,
    });
    const old = append(windowed.id, 'friend');
    for (let index = 0; index < 1002; index++) append(channel.id, 'friend');
    for (let index = 0; index < 1000; index++) append(windowed.id, 'alice');
    expect(store.getUnread(owner.id)).toEqual({
      [channel.id]: { messages: 999, mentions: 999, lastReadId: 0 },
      [windowed.id]: { messages: 0, mentions: 0, lastReadId: 0 },
    });
    expect(store.markRead(windowed.id, old.id)).toBe(old.id);
    expect(store.getUnread(owner.id)[windowed.id]).toEqual({ messages: 0, mentions: 0, lastReadId: old.id });
  } finally {
    store.close();
  }
});

test('network quotas are per-user and nullable limits can be updated independently', () => {
  const store = new Store(':memory:');
  try {
    const alice = store.createUser('alice', 'scrypt:alice')!;
    const bob = store.createUser('bob', 'scrypt:bob')!;
    const input = {
      name: 'First', host: 'irc.example.test', port: 6697, tls: true,
      nick: 'alice', username: 'alice', realname: 'Alice', saslAccount: '',
      autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
    };
    store.setUserLimits(alice.id, { maxNetworks: 1, retentionDays: 3 });
    store.setUserLimits(bob.id, { maxNetworks: 0 });
    store.createNetwork(alice.id, input);
    expect(() => store.createNetwork(alice.id, { ...input, name: 'Second' })).toThrow(NetworkLimitReached);
    expect(() => store.createNetwork(bob.id, input)).toThrow(NetworkLimitReached);
    expect(store.listNetworks(alice.id).map(network => network.name)).toEqual(['First']);
    expect(store.listNetworks(bob.id)).toEqual([]);

    store.setUserLimits(bob.id, { maxNetworks: null });
    store.createNetwork(bob.id, input);
    store.setUserLimits(alice.id, { maxNetworks: null });
    store.createNetwork(alice.id, { ...input, name: 'Second' });
    expect(store.listAdminUsers(0).find(user => user.id === alice.id)).toMatchObject({
      maxNetworks: null, retentionDays: 3, networkCount: 2,
    });
    store.setUserLimits(alice.id, { retentionDays: null });
    expect(store.listAdminUsers(0).find(user => user.id === alice.id)).toMatchObject({
      maxNetworks: null, retentionDays: null,
    });
  } finally {
    store.close();
  }
});

test('history pruning applies each user’s effective retention in bounded batches and updates search', async () => {
  const store = new Store(':memory:');
  try {
    const now = 10 * 86_400_000;
    const day = 86_400_000;
    const users = ['alice', 'bob', 'charlie'].map(username => store.createUser(username, `scrypt:${username}`)!);
    const buffers = users.map((user, index) => {
      const network = store.createNetwork(user.id, {
        name: `IRC ${index}`, host: 'irc.example.test', port: 6697, tls: true,
        nick: user.username, username: user.username, realname: user.username, saslAccount: '',
        autojoin: [], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
      });
      return store.getOrCreateBuffer(network.id, '#chat', 'channel');
    });
    const add = (owner: number, text: string, time: number) => store.appendMessage({
      networkId: buffers[owner]!.networkId, bufferId: buffers[owner]!.id,
      kind: 'privmsg', nick: 'nick', text, time,
    });
    store.setUserLimits(users[0]!.id, { retentionDays: 1 });
    store.setUserLimits(users[1]!.id, { retentionDays: 4 });
    add(0, 'alice expired', now - day - 1);
    add(0, 'alice boundary', now - day);
    add(1, 'bob preserved', now - 3 * day);
    add(1, 'bob expired', now - 4 * day - 1);
    add(2, 'charlie expired', now - 3 * day);
    add(2, 'charlie boundary', now - 2 * day);
    for (let i = 0; i < 5001; i++) add(0, `bulk ${i}`, now - 2 * day);

    await store.pruneHistory(now, null);
    expect(store.searchMessages('expired', { userId: users[0]!.id }).messages).toEqual([]);
    expect(store.searchMessages('bulk', { userId: users[0]!.id }).messages).toEqual([]);
    expect(store.getMessages(buffers[0]!.id).messages.map(message => message.text)).toEqual(['alice boundary']);
    expect(store.searchMessages('expired', { userId: users[1]!.id }).messages).toEqual([]);
    expect(store.getMessages(buffers[1]!.id).messages.map(message => message.text))
      .toEqual(['bob preserved']);
    expect(store.searchMessages('expired', { userId: users[2]!.id }).messages.map(message => message.text))
      .toEqual(['charlie expired']);

    await store.pruneHistory(now, 2);
    expect(store.getMessages(buffers[1]!.id).messages.map(message => message.text))
      .toEqual(['bob preserved']);
    expect(store.getMessages(buffers[2]!.id).messages.map(message => message.text))
      .toEqual(['charlie boundary']);
    expect(store.searchMessages('expired', {}).messages).toEqual([]);
    expect(store.searchMessages('boundary', {}).messages.map(message => message.text))
      .toEqual(['charlie boundary', 'alice boundary']);
  } finally {
    store.close();
  }
});
