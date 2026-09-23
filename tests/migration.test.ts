import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { Store } from '../src/server/store.ts';

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
