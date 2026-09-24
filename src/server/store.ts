import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  AccountUser,
  AdminUserSummary,
  BufferUnread,
  ChatBuffer,
  ChatMessage,
  MentionCandidate,
  Network,
  NetworkConfig,
  NetworkInput,
  SyncedSettings,
  UploadPage,
  UploadRecord,
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
  backfill: number;
  join_delay_seconds: number;
  regain_nick: number;
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
  highlight: number;
};

/** A browser push subscription: its endpoint URL and the keys that encrypt payloads for it. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** What a history export covers: one buffer, or every buffer on a network. */
export type ExportScope = { bufferId: number } | { networkId: number };

type SettingsRow = { data: string };

function defaultSettings(): SyncedSettings {
  return {
    highlights: [], mutedBuffers: [], mutedNetworks: [], hiddenBuffers: [],
    collapsedNetworks: [], pushIncludesText: false, sendTyping: false,
  };
}

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
    backfill: row.backfill === 1,
    joinDelaySeconds: row.join_delay_seconds,
    regainNick: row.regain_nick === 1,
  };
}

type UserRow = { id: number; username: string; is_admin: number; created_at: number };

function userFromRow(row: UserRow): AccountUser {
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1, createdAt: row.created_at };
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
    ...(row.highlight ? { highlight: true } : {}),
  };
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.trunc(limit));
}

type UploadRow = { id: number; url: string; filename: string; size: number; expires_at: number | null; created_at: number };

function uploadFromRow(row: UploadRow): UploadRecord {
  return {
    id: row.id, url: row.url, filename: row.filename, size: row.size, expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

/** A user's network quota prevented a new network from being created. */
export class NetworkLimitReached extends Error {
  constructor() {
    super('Network limit reached');
    this.name = 'NetworkLimitReached';
  }
}

export class Store {
  private readonly db: Database;
  private readonly settingsCache = new Map<number, { settings: SyncedSettings; configured: boolean }>();

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
    if (version > 14) throw new Error(`Unsupported database schema version ${version}`);
    if (version === 14) return;

    // Rebuilding tables that other tables reference requires foreign keys off outside the
    // transaction (https://sqlite.org/lang_altertable.html#otheralter); integrity is rechecked below.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (version < 3) this.migrateToV3(version);
        if (version < 4) {
          this.db.exec(`
            ALTER TABLE networks ADD COLUMN disconnected INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE ignores (
              network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
              nick TEXT NOT NULL,
              nick_key TEXT NOT NULL,
              PRIMARY KEY (network_id, nick_key)
            );
          `);
        }
        if (version < 5) this.migrateToV5();
        if (version < 6) this.migrateToV6();
        if (version < 7) this.migrateToV7();
        if (version < 8) this.migrateToV8();
        if (version < 9) this.migrateToV9();
        if (version < 10) this.migrateToV10();
        if (version < 11) this.migrateToV11();
        if (version < 12) this.migrateToV12();
        if (version < 13) this.migrateToV13();
        this.migrateToV14();
        if (this.db.query('PRAGMA foreign_key_check').all().length) {
          throw new Error('Database migration left dangling references');
        }
        this.db.exec('PRAGMA user_version = 14');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Introduces user accounts. The single legacy account becomes the admin (username `admin`)
   * and owns all existing networks. Without a stored password hash the admin stays unclaimed
   * until first-login setup, and legacy sessions are dropped.
   */
  private migrateToV5(): void {
    this.db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
        away_message TEXT NOT NULL DEFAULT 'Away',
        created_at INTEGER NOT NULL,
        CHECK (is_admin = 1 OR password_hash IS NOT NULL)
      );
      CREATE UNIQUE INDEX users_single_admin ON users(is_admin) WHERE is_admin = 1;
    `);
    this.db.query(`
      INSERT INTO users (id, username, password_hash, is_admin, away_message, created_at)
      SELECT 1, 'admin', password_hash, 1, away_message, ? FROM account_settings WHERE id = 1
    `).run(Date.now());
    this.db.exec(`
      CREATE TABLE networks_v5 (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
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
        display_names TEXT NOT NULL DEFAULT '{}',
        disconnected INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, name)
      );
      INSERT INTO networks_v5 (id, user_id, name, host, port, tls, nick, username, realname,
                               sasl_account, sasl_password, autojoin, commands, relay_nicks,
                               mention_aliases, display_names, disconnected)
        SELECT id, 1, name, host, port, tls, nick, username, realname, sasl_account, sasl_password,
               autojoin, commands, relay_nicks, mention_aliases, display_names, disconnected
        FROM networks;
      DROP TABLE networks;
      ALTER TABLE networks_v5 RENAME TO networks;

      CREATE TABLE sessions_v5 (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions_v5 (token_hash, user_id, expires_at, created_at)
        SELECT token_hash, 1, expires_at, created_at FROM sessions
        WHERE (SELECT password_hash FROM users WHERE id = 1) IS NOT NULL;
      DROP TABLE sessions;
      ALTER TABLE sessions_v5 RENAME TO sessions;
      CREATE INDEX sessions_expiration ON sessions(expires_at);
      CREATE INDEX sessions_user ON sessions(user_id);

      DROP TABLE account_settings;
    `);
  }

  private migrateToV6(): void {
    this.db.exec(`
      ALTER TABLE users ADD COLUMN last_login_at INTEGER;
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));
    `);
  }

  private migrateToV7(): void {
    this.db.exec(`
      ALTER TABLE users ADD COLUMN max_networks INTEGER CHECK (max_networks >= 0);
      ALTER TABLE users ADD COLUMN retention_days INTEGER CHECK (retention_days BETWEEN 1 AND 3650);
      CREATE INDEX messages_retention ON messages(network_id, time);
    `);
  }

  private migrateToV8(): void {
    this.db.exec(`
      CREATE TABLE user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}'
      );
    `);
  }

  private migrateToV9(): void {
    this.db.exec(`
      ALTER TABLE messages ADD COLUMN highlight INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE read_markers (
        buffer_id INTEGER PRIMARY KEY REFERENCES buffers(id) ON DELETE CASCADE,
        last_read_id INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO read_markers (buffer_id, last_read_id)
        SELECT b.id, COALESCE(MAX(m.id), 0) FROM buffers AS b
        LEFT JOIN messages AS m ON m.buffer_id = b.id GROUP BY b.id;
    `);
  }

  /**
   * Server-wide key/value settings (the VAPID key pair) and Web Push subscriptions. Each
   * subscription belongs to the session that registered it, so logging out or revoking
   * a session stops pushes to that device.
   */
  private migrateToV10(): void {
    this.db.exec(`
      CREATE TABLE server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE push_subscriptions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_success_at INTEGER
      );
      CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
      CREATE INDEX push_subscriptions_session ON push_subscriptions(session_hash);
    `);
  }

  /** IRCv3 message ids, unique per buffer, so echoed and replayed copies are stored once. */
  private migrateToV11(): void {
    this.db.exec(`
      ALTER TABLE messages ADD COLUMN msgid TEXT;
      CREATE UNIQUE INDEX messages_msgid ON messages(buffer_id, msgid) WHERE msgid IS NOT NULL;
    `);
  }

  /** Per-network choice to replay missed history with IRCv3 chathistory; existing networks opt in. */
  private migrateToV12(): void {
    this.db.exec('ALTER TABLE networks ADD COLUMN backfill INTEGER NOT NULL DEFAULT 1 CHECK (backfill IN (0, 1))');
  }

  /** Per-network connect options: a delay before autojoin and regaining the preferred nick; both off. */
  private migrateToV13(): void {
    this.db.exec(`
      ALTER TABLE networks ADD COLUMN join_delay_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (join_delay_seconds BETWEEN 0 AND 30);
      ALTER TABLE networks ADD COLUMN regain_nick INTEGER NOT NULL DEFAULT 0 CHECK (regain_nick IN (0, 1));
    `);
  }

  /**
   * Upload permission (on for the admin) and the record of files each user sent to teacup.
   * Deleted rows keep `deleted_at` for a day so the daily upload limits still count them.
   */
  private migrateToV14(): void {
    this.db.exec(`
      ALTER TABLE users ADD COLUMN can_upload INTEGER NOT NULL DEFAULT 0 CHECK (can_upload IN (0, 1));
      UPDATE users SET can_upload = 1 WHERE is_admin = 1;
      CREATE TABLE uploads (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        teacup_hash TEXT NOT NULL,
        url TEXT NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX uploads_user ON uploads(user_id, created_at);
    `);
  }

  private migrateToV3(version: number): void {
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
  }

  close(): void {
    this.db.close();
  }

  createNetwork(userId: number, input: NetworkInput): Network {
    // The capacity check and insert are one write statement: competing creates cannot both
    // observe the last free slot before either inserts its network.
    const row = this.db.query(`
      INSERT INTO networks (user_id, name, host, port, tls, nick, username, realname,
                            sasl_account, sasl_password, autojoin, commands, relay_nicks,
                            mention_aliases, display_names, backfill, join_delay_seconds, regain_nick)
      SELECT u.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM users AS u WHERE u.id = ?
        AND (u.max_networks IS NULL OR
             (SELECT COUNT(*) FROM networks AS n WHERE n.user_id = u.id) < u.max_networks)
      RETURNING id
    `).get(input.name, input.host, input.port, Number(input.tls), input.nick,
      input.username, input.realname, input.saslAccount, input.saslPassword ?? '',
      JSON.stringify(input.autojoin), JSON.stringify(input.commands),
      JSON.stringify(input.relayNicks), JSON.stringify(input.mentionAliases),
      JSON.stringify(input.displayNames), Number(input.backfill), input.joinDelaySeconds,
      Number(input.regainNick), userId) as { id: number } | null;
    if (!row) {
      if (!this.getUser(userId)) throw new Error('User not found');
      throw new NetworkLimitReached();
    }
    return this.getNetwork(row.id)!;
  }

  updateNetwork(id: number, input: NetworkInput): Network | null {
    const existing = this.getNetworkConfig(id);
    if (!existing) return null;
    this.db.query(`
      UPDATE networks SET name = ?, host = ?, port = ?, tls = ?, nick = ?, username = ?,
                          realname = ?, sasl_account = ?, sasl_password = ?, autojoin = ?, commands = ?,
                          relay_nicks = ?, mention_aliases = ?, display_names = ?, backfill = ?,
                          join_delay_seconds = ?, regain_nick = ?
      WHERE id = ?
    `).run(input.name, input.host, input.port, Number(input.tls), input.nick,
      input.username, input.realname, input.saslAccount,
      input.saslPassword?.trim() ? input.saslPassword : existing.saslPassword,
      JSON.stringify(input.autojoin), JSON.stringify(input.commands),
      JSON.stringify(input.relayNicks), JSON.stringify(input.mentionAliases),
      JSON.stringify(input.displayNames), Number(input.backfill), input.joinDelaySeconds,
      Number(input.regainNick), id);
    return this.getNetwork(id);
  }

  removeNetwork(id: number): void {
    this.db.query('DELETE FROM networks WHERE id = ?').run(id);
  }

  /** All networks, or only those owned by `userId`. */
  listNetworks(userId?: number): Network[] {
    return (this.db.query('SELECT * FROM networks WHERE ?1 IS NULL OR user_id = ?1 ORDER BY id')
      .all(userId ?? null) as NetworkRow[]).map(networkFromRow);
  }

  networkOwner(networkId: number): number | null {
    const row = this.db.query('SELECT user_id FROM networks WHERE id = ?').get(networkId) as { user_id: number } | null;
    return row?.user_id ?? null;
  }

  bufferOwner(bufferId: number): number | null {
    const row = this.db.query(`
      SELECT n.user_id FROM buffers AS b JOIN networks AS n ON n.id = b.network_id WHERE b.id = ?
    `).get(bufferId) as { user_id: number } | null;
    return row?.user_id ?? null;
  }

  getNetwork(id: number): Network | null {
    const row = this.db.query('SELECT * FROM networks WHERE id = ?').get(id) as NetworkRow | null;
    return row ? networkFromRow(row) : null;
  }

  getNetworkConfig(id: number): NetworkConfig | null {
    const row = this.db.query('SELECT * FROM networks WHERE id = ?').get(id) as NetworkRow | null;
    return row ? { ...networkFromRow(row), saslPassword: row.sasl_password } : null;
  }

  isNetworkDisconnected(id: number): boolean {
    const row = this.db.query('SELECT disconnected FROM networks WHERE id = ?').get(id) as { disconnected: number } | null;
    return row?.disconnected === 1;
  }

  setNetworkDisconnected(id: number, disconnected: boolean): void {
    this.db.query('UPDATE networks SET disconnected = ? WHERE id = ?').run(Number(disconnected), id);
  }

  listIgnores(networkId: number): string[] {
    return (this.db.query('SELECT nick FROM ignores WHERE network_id = ? ORDER BY nick_key')
      .all(networkId) as Array<{ nick: string }>).map(row => row.nick);
  }

  allIgnores(userId: number): Record<number, string[]> {
    const ignores: Record<number, string[]> = {};
    for (const row of this.db.query(`
      SELECT i.network_id, i.nick FROM ignores AS i JOIN networks AS n ON n.id = i.network_id
      WHERE n.user_id = ? ORDER BY i.nick_key
    `).all(userId) as Array<{ network_id: number; nick: string }>) {
      (ignores[row.network_id] ??= []).push(row.nick);
    }
    return ignores;
  }

  addIgnore(networkId: number, nick: string): void {
    this.db.query(`
      INSERT INTO ignores (network_id, nick, nick_key) VALUES (?, ?, ?)
      ON CONFLICT(network_id, nick_key) DO NOTHING
    `).run(networkId, nick, nick.toLowerCase());
  }

  removeIgnore(networkId: number, nick: string): void {
    this.db.query('DELETE FROM ignores WHERE network_id = ? AND nick_key = ?').run(networkId, nick.toLowerCase());
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

  /** All buffers, or only those on networks owned by `userId`. */
  listBuffers(userId?: number): ChatBuffer[] {
    return (this.db.query(`
      SELECT b.id, b.network_id, b.name, b.kind FROM buffers AS b JOIN networks AS n ON n.id = b.network_id
      WHERE ?1 IS NULL OR n.user_id = ?1 ORDER BY b.id
    `).all(userId ?? null) as BufferRow[]).map(bufferFromRow);
  }

  removeBuffer(id: number): void {
    this.db.query('DELETE FROM buffers WHERE id = ?').run(id);
  }

  clearMessages(bufferId: number): void {
    this.db.query('DELETE FROM messages WHERE buffer_id = ?').run(bufferId);
  }

  /** All owned buffers, including buffers with no unread messages or marker yet. */
  getUnread(userId: number): Record<number, BufferUnread> {
    const unread: Record<number, BufferUnread> = {};
    const buffers = this.db.query(`
      SELECT b.id, b.kind, COALESCE(r.last_read_id, 0) AS last_read_id,
             n.nick, n.mention_aliases, n.relay_nicks
      FROM buffers AS b JOIN networks AS n ON n.id = b.network_id
      LEFT JOIN read_markers AS r ON r.buffer_id = b.id
      WHERE n.user_id = ? ORDER BY b.id
    `).all(userId) as Array<{
      id: number; kind: ChatBuffer['kind']; last_read_id: number;
      nick: string; mention_aliases: string; relay_nicks: string;
    }>;
    const recent = this.db.query(`
      SELECT kind, nick, text, from_network, highlight FROM messages
      WHERE buffer_id = ? AND id > ? ORDER BY id DESC LIMIT 1000
    `);
    for (const buffer of buffers) {
      let messages = 0;
      let mentions = 0;
      const ownNames = [buffer.nick, ...(JSON.parse(buffer.mention_aliases) as string[])]
        .map(name => name.toLowerCase());
      const relayNicks = JSON.parse(buffer.relay_nicks) as string[];
      const rows = recent.all(buffer.id, buffer.last_read_id) as Array<
        Pick<MessageRow, 'kind' | 'nick' | 'text' | 'from_network' | 'highlight'>
      >;
      for (const row of rows) {
        const sender = row.nick && !row.from_network && row.kind !== 'system'
          ? displayIdentity(row, relayNicks).mentionTarget : null;
        if (sender && ownNames.includes(sender.toLowerCase())) continue;
        messages = Math.min(999, messages + 1);
        if (sender && (row.highlight || buffer.kind === 'query')) mentions = Math.min(999, mentions + 1);
      }
      unread[buffer.id] = { messages, mentions, lastReadId: buffer.last_read_id };
    }
    return unread;
  }

  /** Returns the current marker for a valid message in this buffer, or null for an invalid pair. */
  markRead(bufferId: number, messageId: number): number | null {
    const row = this.db.query(`
      INSERT INTO read_markers (buffer_id, last_read_id)
      SELECT buffer_id, id FROM messages WHERE id = ? AND buffer_id = ?
      ON CONFLICT(buffer_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)
      RETURNING last_read_id
    `).get(messageId, bufferId) as { last_read_id: number } | null;
    return row?.last_read_id ?? null;
  }

  appendMessage(input: Omit<ChatMessage, 'id'>): ChatMessage {
    return this.appendUniqueMessage(input, null)!;
  }

  /**
   * Stores a message, or returns null when this buffer already holds its IRCv3 msgid. Replayed
   * history (`replayed`) is also skipped when an identical line with the same time is stored.
   */
  appendUniqueMessage(input: Omit<ChatMessage, 'id'>, msgid: string | null, replayed = false): ChatMessage | null {
    const row = this.db.query(`
      INSERT INTO messages (network_id, buffer_id, kind, nick, text, time,
                            from_network, connection_event, is_motd, highlight, msgid)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE ?12 = 0 OR NOT EXISTS (
        SELECT 1 FROM messages
        WHERE network_id = ?1 AND time = ?6 AND buffer_id = ?2 AND nick IS ?4 AND text = ?5
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `).get(input.networkId, input.bufferId, input.kind, input.nick, input.text, input.time,
      Number(input.fromNetwork === true), input.connectionEvent ?? null, Number(input.isMotd === true),
      Number(input.highlight === true), msgid, Number(replayed)) as { id: number } | null;
    return row ? { id: row.id, ...input } : null;
  }

  /** Time of the newest non-system message in a buffer, where chathistory backfill resumes. */
  latestMessageTime(bufferId: number): number | null {
    const row = this.db.query(`
      SELECT MAX(time) AS time FROM messages WHERE buffer_id = ? AND kind != 'system'
    `).get(bufferId) as { time: number | null };
    return row.time;
  }

  /** Time of the newest stored line on a network, including connection markers. */
  latestNetworkTime(networkId: number): number | null {
    const row = this.db.query('SELECT MAX(time) AS time FROM messages WHERE network_id = ?')
      .get(networkId) as { time: number | null };
    return row.time;
  }

  getMessages(bufferId: number, before?: number, limit?: number): { messages: ChatMessage[]; hasMore: boolean } {
    const size = pageSize(limit);
    const rows = this.db.query(`
      SELECT * FROM messages WHERE buffer_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?
    `).all(bufferId, before ?? Number.MAX_SAFE_INTEGER, size + 1) as MessageRow[];
    return { messages: rows.slice(0, size).reverse().map(messageFromRow), hasMore: rows.length > size };
  }

  /** One export page after `afterId`, oldest first; `since`/`until` are inclusive message times. */
  exportMessages(
    scope: ExportScope, afterId: number, limit: number, range: { since?: number; until?: number } = {},
  ): Array<{ message: ChatMessage; bufferName: string }> {
    const column = 'bufferId' in scope ? 'm.buffer_id' : 'm.network_id';
    const rows = this.db.query(`
      SELECT m.*, b.name AS buffer_name FROM messages AS m JOIN buffers AS b ON b.id = m.buffer_id
      WHERE ${column} = ? AND m.id > ? AND (? IS NULL OR m.time >= ?) AND (? IS NULL OR m.time <= ?)
      ORDER BY m.id LIMIT ?
    `).all('bufferId' in scope ? scope.bufferId : scope.networkId, afterId, range.since ?? null, range.since ?? null,
      range.until ?? null, range.until ?? null, limit) as Array<MessageRow & { buffer_name: string }>;
    return rows.map(row => ({ message: messageFromRow(row), bufferName: row.buffer_name }));
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
    filters: {
      userId?: number; networkId?: number; bufferId?: number; before?: number; limit?: number; since?: number; until?: number;
    },
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
        AND (? IS NULL OR m.network_id IN (SELECT id FROM networks WHERE user_id = ?))
        AND m.buffer_id = COALESCE(?, m.buffer_id) AND m.id < ?
        AND (? IS NULL OR m.time >= ?) AND (? IS NULL OR m.time <= ?)
      ORDER BY m.id DESC LIMIT ?
    `).all(literal, filters.networkId ?? null, filters.userId ?? null, filters.userId ?? null, filters.bufferId ?? null,
      filters.before ?? Number.MAX_SAFE_INTEGER, filters.since ?? null, filters.since ?? null,
      filters.until ?? null, filters.until ?? null, size + 1) as MessageRow[];
    return { messages: rows.slice(0, size).map(messageFromRow), hasMore: rows.length > size };
  }

  createSession(tokenHash: string, userId: number, expiresAt: number, createdAt = Date.now()): void {
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at,
          created_at = excluded.created_at
      `).run(tokenHash, userId, expiresAt, createdAt);
      this.db.query('UPDATE users SET last_login_at = ? WHERE id = ?').run(createdAt, userId);
    })();
  }

  listSessions(userId: number, now: number): Array<{ id: string; createdAt: number; expiresAt: number }> {
    return (this.db.query(`
      SELECT token_hash, created_at, expires_at FROM sessions
      WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, token_hash
    `).all(userId, now) as Array<{ token_hash: string; created_at: number; expires_at: number }>)
      .map(row => ({ id: row.token_hash, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  /** The account behind an unexpired session, or null. */
  sessionUser(tokenHash: string, now: number): AccountUser | null {
    const row = this.db.query(`
      SELECT u.id, u.username, u.is_admin, u.created_at FROM sessions AS s JOIN users AS u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, now) as UserRow | null;
    return row ? userFromRow(row) : null;
  }

  deleteSession(tokenHash: string, userId: number): void {
    this.db.query('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(tokenHash, userId);
  }

  /** Sets a password and revokes the user's sessions except `keepSession`. */
  setPassword(userId: number, passwordHash: string, keepSession: string | null): void {
    this.db.transaction(() => {
      this.db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
      this.db.query('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, keepSession);
    })();
  }

  /** True until the admin account has been claimed on first login. */
  setupRequired(): boolean {
    return this.db.query('SELECT 1 FROM users WHERE is_admin = 1 AND password_hash IS NOT NULL').get() === null;
  }

  /** Claims the unclaimed admin account; null when setup already happened. */
  claimAdmin(username: string, passwordHash: string): AccountUser | null {
    const row = this.db.query(`
      UPDATE users SET username = ?, password_hash = ?, created_at = ?
      WHERE is_admin = 1 AND password_hash IS NULL RETURNING id, username, is_admin, created_at
    `).get(username, passwordHash, Date.now()) as UserRow | null;
    return row ? userFromRow(row) : null;
  }

  /** Creates a non-admin user; null when the username is taken. */
  createUser(username: string, passwordHash: string): AccountUser | null {
    const row = this.db.query(`
      INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(username) DO NOTHING RETURNING id, username, is_admin, created_at
    `).get(username, passwordHash, Date.now()) as UserRow | null;
    return row ? userFromRow(row) : null;
  }

  listUsers(): AccountUser[] {
    return (this.db.query('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all() as UserRow[])
      .map(userFromRow);
  }

  listAdminUsers(now: number): Array<Omit<AdminUserSummary, 'connectedCount'>> {
    const rows = this.db.query(`
      SELECT u.id, u.username, u.is_admin, u.created_at, u.disabled, u.last_login_at,
        u.max_networks, u.retention_days, u.can_upload,
        (SELECT COUNT(*) FROM networks AS n WHERE n.user_id = u.id) AS network_count,
        (SELECT COUNT(*) FROM sessions AS s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
      FROM users AS u ORDER BY u.id
    `).all(now) as Array<UserRow & {
      disabled: number; last_login_at: number | null; network_count: number; session_count: number;
      max_networks: number | null; retention_days: number | null; can_upload: number;
    }>;
    return rows.map(row => ({
      ...userFromRow(row),
      disabled: row.disabled === 1,
      lastLoginAt: row.last_login_at,
      networkCount: row.network_count,
      sessionCount: row.session_count,
      maxNetworks: row.max_networks,
      retentionDays: row.retention_days,
      canUpload: row.can_upload === 1,
    }));
  }

  /** Omitted fields stay unchanged; null clears a user-specific limit. */
  setUserLimits(
    userId: number, limits: { maxNetworks?: number | null; retentionDays?: number | null; canUpload?: boolean },
  ): void {
    this.db.query(`
      UPDATE users SET
        max_networks = CASE WHEN ? THEN ? ELSE max_networks END,
        retention_days = CASE WHEN ? THEN ? ELSE retention_days END,
        can_upload = COALESCE(?, can_upload)
      WHERE id = ?
    `).run(Number(limits.maxNetworks !== undefined), limits.maxNetworks ?? null,
      Number(limits.retentionDays !== undefined), limits.retentionDays ?? null,
      limits.canUpload === undefined ? null : Number(limits.canUpload), userId);
  }

  canUpload(userId: number): boolean {
    const row = this.db.query('SELECT can_upload FROM users WHERE id = ?').get(userId) as { can_upload: number } | null;
    return row?.can_upload === 1;
  }

  addUpload(userId: number, upload: Omit<UploadRecord, 'id'> & { hash: string }): UploadRecord {
    const row = this.db.query(`
      INSERT INTO uploads (user_id, teacup_hash, url, filename, size, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(userId, upload.hash, upload.url, upload.filename, upload.size, upload.expiresAt, upload.createdAt) as
      { id: number };
    const { hash: _hash, ...record } = upload;
    return { id: row.id, ...record };
  }

  /** Undeleted uploads that teacup still serves, newest first, below `before`. */
  listUploads(userId: number, now: number, before?: number, limit?: number): UploadPage {
    const size = pageSize(limit);
    const rows = this.db.query(`
      SELECT id, url, filename, size, expires_at, created_at FROM uploads
      WHERE user_id = ? AND id < ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY id DESC LIMIT ?
    `).all(userId, before ?? Number.MAX_SAFE_INTEGER, now, size + 1) as UploadRow[];
    return { uploads: rows.slice(0, size).map(uploadFromRow), hasMore: rows.length > size };
  }

  /** The teacup id of an undeleted upload owned by `userId`, or null. */
  uploadHash(userId: number, id: number): string | null {
    const row = this.db.query(`
      SELECT teacup_hash FROM uploads WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(id, userId) as { teacup_hash: string } | null;
    return row?.teacup_hash ?? null;
  }

  markUploadDeleted(id: number, now: number): void {
    this.db.query('UPDATE uploads SET deleted_at = ? WHERE id = ?').run(now, id);
  }

  /** Teacup ids of a user's uploads that are neither deleted nor expired. */
  liveUploadHashes(userId: number, now: number): string[] {
    return (this.db.query(`
      SELECT teacup_hash FROM uploads
      WHERE user_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).all(userId, now) as Array<{ teacup_hash: string }>).map(row => row.teacup_hash);
  }

  /** Upload times and sizes since `since`, oldest first, including deleted uploads; feeds the rate limits. */
  recentUploads(userId: number, since: number): Array<{ createdAt: number; size: number }> {
    return this.db.query(`
      SELECT created_at AS createdAt, size FROM uploads WHERE user_id = ? AND created_at > ? ORDER BY created_at
    `).all(userId, since) as Array<{ createdAt: number; size: number }>;
  }

  /** Drops rows older than `before` that are deleted or expired; newer ones still count toward limits. */
  pruneUploads(now: number, before: number): void {
    this.db.query(`
      DELETE FROM uploads WHERE created_at < ?
        AND (deleted_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))
    `).run(before, now);
  }

  isUserDisabled(userId: number): boolean {
    const row = this.db.query('SELECT disabled FROM users WHERE id = ?').get(userId) as { disabled: number } | null;
    return row?.disabled === 1;
  }

  /** Disabling revokes every session in the same transaction as the account change. */
  setUserDisabled(userId: number, disabled: boolean): void {
    this.db.transaction(() => {
      this.db.query('UPDATE users SET disabled = ? WHERE id = ?').run(Number(disabled), userId);
      if (disabled) this.db.query('DELETE FROM sessions WHERE user_id = ?').run(userId);
    })();
  }

  getUser(id: number): AccountUser | null {
    const row = this.db.query('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(id) as UserRow | null;
    return row ? userFromRow(row) : null;
  }

  /** Login lookup; `passwordHash` is null for the unclaimed admin. */
  getCredentials(username: string): { user: AccountUser; passwordHash: string | null } | null {
    const row = this.db.query(`
      SELECT id, username, is_admin, created_at, password_hash FROM users WHERE username = ?
    `).get(username) as (UserRow & { password_hash: string | null }) | null;
    return row ? { user: userFromRow(row), passwordHash: row.password_hash } : null;
  }

  getPasswordHash(userId: number): string | null {
    const row = this.db.query('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      { password_hash: string | null } | null;
    return row?.password_hash ?? null;
  }

  /** Deletes a user together with their sessions, networks, buffers, and history. */
  removeUser(id: number): void {
    this.db.query('DELETE FROM users WHERE id = ?').run(id);
    this.settingsCache.delete(id);
  }

  getAwayMessage(userId: number): string {
    const row = this.db.query('SELECT away_message FROM users WHERE id = ?').get(userId) as { away_message: string } | null;
    if (!row) throw new Error('User not found');
    return row.away_message;
  }

  setAwayMessage(userId: number, message: string): void {
    this.db.query('UPDATE users SET away_message = ? WHERE id = ?').run(message, userId);
  }

  /** A missing row means this user has not yet imported legacy browser settings. */
  getSettingsState(userId: number): { settings: SyncedSettings; configured: boolean } {
    const cached = this.settingsCache.get(userId);
    if (cached) return cached;
    const row = this.db.query('SELECT data FROM user_settings WHERE user_id = ?').get(userId) as SettingsRow | null;
    const state = {
      settings: row ? { ...defaultSettings(), ...JSON.parse(row.data) as Partial<SyncedSettings> } : defaultSettings(),
      configured: row !== null,
    };
    this.settingsCache.set(userId, state);
    return state;
  }

  patchSettings(userId: number, patch: Partial<SyncedSettings>): SyncedSettings {
    const settings = { ...this.getSettingsState(userId).settings, ...patch };
    this.db.query(`
      INSERT INTO user_settings (user_id, data) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data
    `).run(userId, JSON.stringify(settings));
    this.settingsCache.delete(userId);
    return this.getSettingsState(userId).settings;
  }

  pruneSessions(now: number): void {
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  /** Returns the value stored under `key`, storing `create()` first when there is none. */
  serverSetting(key: string, create: () => string): string {
    const select = this.db.query('SELECT value FROM server_settings WHERE key = ?');
    const existing = select.get(key) as { value: string } | null;
    if (existing) return existing.value;
    this.db.query('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, create());
    return (select.get(key) as { value: string }).value;
  }

  /**
   * Registers or refreshes a device's push subscription under the session that sent it; an
   * endpoint moves to the newest session that registers it. False when the user already has
   * `limit` other subscriptions.
   */
  savePushSubscription(userId: number, sessionHash: string, subscription: PushTarget, limit: number, now: number): boolean {
    return this.db.transaction(() => {
      const { count } = this.db.query(`
        SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ? AND endpoint != ?
      `).get(userId, subscription.endpoint) as { count: number };
      if (count >= limit) return false;
      this.db.query(`
        INSERT INTO push_subscriptions (user_id, session_hash, endpoint, p256dh, auth, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash,
          p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, last_success_at = NULL
      `).run(userId, sessionHash, subscription.endpoint, subscription.p256dh, subscription.auth, now);
      return true;
    })();
  }

  deletePushSubscription(userId: number, endpoint: string): void {
    this.db.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  }

  listPushSubscriptions(userId: number): Array<PushTarget & { id: number }> {
    return this.db.query(`
      SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY id
    `).all(userId) as Array<PushTarget & { id: number }>;
  }

  markPushDelivered(id: number, now: number): void {
    this.db.query('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?').run(now, id);
  }

  /** Drops a subscription the push service reported as gone (404/410). */
  removePushSubscription(id: number): void {
    this.db.query('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  /** Deletes expired history in bounded writes, letting the event loop run between batches. */
  async pruneHistory(now: number, globalRetentionDays: number | null): Promise<void> {
    const users = this.db.query('SELECT id, retention_days FROM users WHERE retention_days IS NOT NULL OR ? IS NOT NULL')
      .all(globalRetentionDays) as Array<{ id: number; retention_days: number | null }>;
    const expired = this.db.query(`
      DELETE FROM messages WHERE id IN (
        SELECT m.id FROM networks AS n JOIN messages AS m ON m.network_id = n.id
        WHERE n.user_id = ? AND m.time < ? LIMIT 5000
      )
    `);
    for (const user of users) {
      const retentionDays = user.retention_days ?? globalRetentionDays;
      if (retentionDays === null) continue;
      const cutoff = now - retentionDays * 86_400_000;
      while (true) {
        const { changes } = expired.run(user.id, cutoff);
        if (changes < 5000) break;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
  }
}
