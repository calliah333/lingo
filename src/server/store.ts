import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  ChatBuffer,
  ChatMessage,
  MentionCandidate,
  Network,
  NetworkConfig,
  NetworkInput,
} from '../shared/contracts.ts';
import { displayIdentity } from '../shared/identity.ts';

type NetworkRow = {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: number;
  nick: string;
  username: string;
  realname: string;
  sasl_account: string;
  sasl_password: string;
  autojoin: string;
  commands: string;
  relay_nicks: string;
  mention_aliases: string;
  display_names: string;
};

type BufferRow = {
  id: number;
  network_id: number;
  name: string;
  kind: ChatBuffer['kind'];
};

type MessageRow = {
  id: number;
  network_id: number;
  buffer_id: number;
  kind: ChatMessage['kind'];
  nick: string | null;
  text: string;
  time: number;
  from_network: number;
  connection_event: ChatMessage['connectionEvent'] | null;
  is_motd: number;
};

function networkFromRow(row: NetworkRow): Network {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    tls: Boolean(row.tls),
    nick: row.nick,
    username: row.username,
    realname: row.realname,
    saslAccount: row.sasl_account,
    autojoin: JSON.parse(row.autojoin) as string[],
    commands: JSON.parse(row.commands) as string[],
    relayNicks: JSON.parse(row.relay_nicks) as string[],
    mentionAliases: JSON.parse(row.mention_aliases) as string[],
    displayNames: JSON.parse(row.display_names) as Record<string, string>,
  };
}

function bufferFromRow(row: BufferRow): ChatBuffer {
  return { id: row.id, networkId: row.network_id, name: row.name, kind: row.kind };
}

function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    networkId: row.network_id,
    bufferId: row.buffer_id,
    kind: row.kind,
    nick: row.nick,
    text: row.text,
    time: row.time,
    ...(row.from_network ? { fromNetwork: true } : {}),
    ...(row.connection_event ? { connectionEvent: row.connection_event } : {}),
    ...(row.is_motd ? { isMotd: true as const } : {}),
  };
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.trunc(limit));
}

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    const versionRow: unknown = this.db.query('PRAGMA user_version').get();
    if (!versionRow || typeof versionRow !== 'object' || !('user_version' in versionRow) ||
      typeof versionRow.user_version !== 'number') {
      throw new Error('Could not read database schema version');
    }
    const version = versionRow.user_version;
    if (version > 3) throw new Error(`Unsupported database schema version ${version}`);
    if (version === 3) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (version === 0) {
        this.db.exec(`
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
          commands TEXT NOT NULL,
          relay_nicks TEXT NOT NULL DEFAULT '[]',
          mention_aliases TEXT NOT NULL DEFAULT '[]',
          display_names TEXT NOT NULL DEFAULT '{}'
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
      } else if (version === 1) {
        this.db.exec(`
          ALTER TABLE networks ADD COLUMN relay_nicks TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE networks ADD COLUMN mention_aliases TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE networks ADD COLUMN display_names TEXT NOT NULL DEFAULT '{}';
        `);
      }
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN from_network INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN connection_event TEXT
          CHECK (connection_event IN ('connected', 'disconnected'));
        ALTER TABLE messages ADD COLUMN is_motd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
        UPDATE sessions SET created_at = MAX(0, expires_at - 2592000000);
        CREATE TABLE account_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          password_hash TEXT,
          away_message TEXT NOT NULL DEFAULT 'Away'
        );
        INSERT INTO account_settings (id) VALUES (1);
      `);
      this.db.exec('PRAGMA user_version = 3');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createNetwork(input: NetworkInput): Network {
    const result = this.db.query(`
      INSERT INTO networks (name, host, port, tls, nick, username, realname,
                            sasl_account, sasl_password, autojoin, commands, relay_nicks,
                            mention_aliases, display_names)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.name, input.host, input.port, Number(input.tls), input.nick,
      input.username, input.realname, input.saslAccount, input.saslPassword ?? '',
      JSON.stringify(input.autojoin), JSON.stringify(input.commands),
      JSON.stringify(input.relayNicks), JSON.stringify(input.mentionAliases),
      JSON.stringify(input.displayNames));
    return this.getNetwork(Number(result.lastInsertRowid))!;
  }

  updateNetwork(id: number, input: NetworkInput): Network | null {
    const existing = this.getNetworkConfig(id);
    if (!existing) return null;
    this.db.query(`
      UPDATE networks SET name = ?, host = ?, port = ?, tls = ?, nick = ?, username = ?,
                          realname = ?, sasl_account = ?, sasl_password = ?, autojoin = ?, commands = ?,
                          relay_nicks = ?, mention_aliases = ?, display_names = ?
      WHERE id = ?
    `).run(input.name, input.host, input.port, Number(input.tls), input.nick,
      input.username, input.realname, input.saslAccount,
      input.saslPassword?.trim() ? input.saslPassword : existing.saslPassword,
      JSON.stringify(input.autojoin), JSON.stringify(input.commands),
      JSON.stringify(input.relayNicks), JSON.stringify(input.mentionAliases),
      JSON.stringify(input.displayNames), id);
    return this.getNetwork(id);
  }

  removeNetwork(id: number): void {
    this.db.query('DELETE FROM networks WHERE id = ?').run(id);
  }

  listNetworks(): Network[] {
    return (this.db.query('SELECT * FROM networks ORDER BY id').all() as NetworkRow[]).map(networkFromRow);
  }

  getNetwork(id: number): Network | null {
    const row = this.db.query('SELECT * FROM networks WHERE id = ?').get(id) as NetworkRow | null;
    return row ? networkFromRow(row) : null;
  }

  getNetworkConfig(id: number): NetworkConfig | null {
    const row = this.db.query('SELECT * FROM networks WHERE id = ?').get(id) as NetworkRow | null;
    return row ? { ...networkFromRow(row), saslPassword: row.sasl_password } : null;
  }

  getOrCreateBuffer(networkId: number, name: string, kind: ChatBuffer['kind']): ChatBuffer {
    const nameKey = name.toLowerCase();
    this.db.query(`
      INSERT INTO buffers (network_id, name, name_key, kind) VALUES (?, ?, ?, ?)
      ON CONFLICT(network_id, kind, name_key) DO NOTHING
    `).run(networkId, name, nameKey, kind);
    const row = this.db.query(`
      SELECT id, network_id, name, kind FROM buffers
      WHERE network_id = ? AND kind = ? AND name_key = ?
    `).get(networkId, kind, nameKey) as BufferRow;
    return bufferFromRow(row);
  }

  getBuffer(id: number): ChatBuffer | null {
    const row = this.db.query('SELECT id, network_id, name, kind FROM buffers WHERE id = ?').get(id) as BufferRow | null;
    return row ? bufferFromRow(row) : null;
  }

  listBuffers(): ChatBuffer[] {
    return (this.db.query('SELECT id, network_id, name, kind FROM buffers ORDER BY id').all() as BufferRow[])
      .map(bufferFromRow);
  }

  removeBuffer(id: number): void {
    this.db.query('DELETE FROM buffers WHERE id = ?').run(id);
  }

  appendMessage(input: Omit<ChatMessage, 'id'>): ChatMessage {
    const result = this.db.query(`
      INSERT INTO messages (network_id, buffer_id, kind, nick, text, time,
                            from_network, connection_event, is_motd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.networkId, input.bufferId, input.kind, input.nick, input.text, input.time,
      Number(input.fromNetwork === true), input.connectionEvent ?? null, Number(input.isMotd === true));
    return { id: Number(result.lastInsertRowid), ...input };
  }

  getMessages(bufferId: number, before?: number, limit?: number): { messages: ChatMessage[]; hasMore: boolean } {
    const size = pageSize(limit);
    const rows = this.db.query(`
      SELECT * FROM messages WHERE buffer_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?
    `).all(bufferId, before ?? Number.MAX_SAFE_INTEGER, size + 1) as MessageRow[];
    return { messages: rows.slice(0, size).reverse().map(messageFromRow), hasMore: rows.length > size };
  }

  listRecentParticipants(bufferId: number, limit = 100): MentionCandidate[] {
    const size = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.trunc(limit))) : 100;
    if (size === 0) return [];
    const network = this.db.query(`
      SELECT n.relay_nicks, n.display_names FROM buffers AS b
      JOIN networks AS n ON n.id = b.network_id
      WHERE b.id = ?
    `).get(bufferId) as { relay_nicks: string; display_names: string } | null;
    if (!network) return [];

    const relayNicks = JSON.parse(network.relay_nicks) as string[];
    const displayNames = JSON.parse(network.display_names) as Record<string, string>;
    const rows = this.db.query(`
      SELECT nick, text FROM messages
      WHERE buffer_id = ? AND kind != 'system'
      ORDER BY id DESC LIMIT 2000
    `).all(bufferId) as Pick<MessageRow, 'nick' | 'text'>[];
    const seen = new Set<string>();
    const participants: MentionCandidate[] = [];
    for (const row of rows) {
      const identity = displayIdentity(row, relayNicks, displayNames);
      const name = identity.nick?.trim();
      const mention = identity.mentionTarget?.trim();
      if (!name || !mention) continue;
      const key = mention.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push({ name, mention });
      if (participants.length === size) break;
    }
    return participants;
  }

  searchMessages(
    query: string,
    filters: { networkId?: number; bufferId?: number; before?: number; limit?: number; since?: number; until?: number },
  ): { messages: ChatMessage[]; hasMore: boolean } {
    // SQLite's FTS5 parser treats an embedded NUL as the end of the query string.
    const text = query.replaceAll('\0', ' ').trim();
    if (!text) return { messages: [], hasMore: false };
    const size = pageSize(filters.limit);
    // A quoted FTS5 phrase treats user input as text, never as FTS operators or column selectors.
    const literal = `"${text.replaceAll('"', '""')}"`;
    const rows = this.db.query(`
      SELECT m.* FROM messages_fts JOIN messages AS m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.network_id = COALESCE(?, m.network_id)
        AND m.buffer_id = COALESCE(?, m.buffer_id) AND m.id < ?
        AND (? IS NULL OR m.time >= ?) AND (? IS NULL OR m.time <= ?)
      ORDER BY m.id DESC LIMIT ?
    `).all(literal, filters.networkId ?? null, filters.bufferId ?? null,
      filters.before ?? Number.MAX_SAFE_INTEGER, filters.since ?? null, filters.since ?? null,
      filters.until ?? null, filters.until ?? null, size + 1) as MessageRow[];
    return { messages: rows.slice(0, size).map(messageFromRow), hasMore: rows.length > size };
  }

  createSession(tokenHash: string, expiresAt: number, createdAt = Date.now()): void {
    this.db.query(`
      INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(tokenHash, expiresAt, createdAt);
  }

  listSessions(now: number): Array<{ id: string; createdAt: number; expiresAt: number }> {
    return (this.db.query(`
      SELECT token_hash, created_at, expires_at FROM sessions
      WHERE expires_at > ? ORDER BY created_at DESC, token_hash
    `).all(now) as Array<{ token_hash: string; created_at: number; expires_at: number }>)
      .map(row => ({ id: row.token_hash, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  hasSession(tokenHash: string, now: number): boolean {
    return this.db.query('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, now) !== null;
  }

  deleteSession(tokenHash: string): void {
    this.db.query('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  revokeOtherSessions(currentHash: string, passwordHash: string): void {
    this.db.transaction(() => {
      this.db.query('UPDATE account_settings SET password_hash = ? WHERE id = 1').run(passwordHash);
      this.db.query('DELETE FROM sessions WHERE token_hash != ?').run(currentHash);
    })();
  }

  getPasswordHash(): string | null {
    const row = this.db.query('SELECT password_hash FROM account_settings WHERE id = 1')
      .get() as { password_hash: string | null } | null;
    if (!row) throw new Error('Account settings missing');
    return row.password_hash;
  }

  getAwayMessage(): string {
    const row = this.db.query('SELECT away_message FROM account_settings WHERE id = 1')
      .get() as { away_message: string } | null;
    if (!row) throw new Error('Account settings missing');
    return row.away_message;
  }

  setAwayMessage(message: string): void {
    this.db.query('UPDATE account_settings SET away_message = ? WHERE id = 1').run(message);
  }

  pruneSessions(now: number): void {
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}
