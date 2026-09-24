export interface NetworkInput {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  saslAccount: string;
  saslPassword?: string;
  autojoin: string[];
  commands: string[];
  relayNicks: string[];
  mentionAliases: string[];
  displayNames: Record<string, string>;
  /** Replays missed history with IRCv3 chathistory when the server offers it. */
  backfill: boolean;
  /** Seconds to wait after registration before autojoining, so services can identify first (0–30). */
  joinDelaySeconds: number;
  /** Sends `NickServ REGAIN <nick>` when registered under a fallback nick with SASL configured. */
  regainNick: boolean;
}

export interface MentionCandidate {
  name: string;
  mention: string;
}

export type Network = Omit<NetworkInput, 'saslPassword'> & {
  id: number;
};

export type NetworkConfig = Network & {
  saslPassword: string;
};

export interface ChatBuffer {
  id: number;
  networkId: number;
  name: string;
  kind: 'server' | 'channel' | 'query';
}

export interface ChatMessage {
  id: number;
  networkId: number;
  bufferId: number;
  kind: 'privmsg' | 'notice' | 'action' | 'system';
  nick: string | null;
  text: string;
  time: number;
  fromNetwork?: boolean;
  connectionEvent?: 'connected' | 'disconnected';
  isMotd?: true;
  highlight?: boolean;
}

/** One line of a network history export (JSONL); buffer exports write plain `ChatMessage` lines. */
export type NetworkExportLine = ChatMessage & { bufferName: string };

export interface ChannelUser {
  nick: string;
  prefix: string;
  modes: string[];
}

export interface ChannelState {
  bufferId: number;
  topic: string | null;
  users: ChannelUser[];
}

export interface NetworkStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  nick: string;
  error?: string;
}

export interface ChannelListEntry {
  name: string;
  users: number;
  topic: string;
}

/** `idle`: no LIST requested on this connection; `loading`: results are still arriving. */
export interface ChannelListStatus {
  networkId: number;
  state: 'idle' | 'loading' | 'complete';
  total: number;
  updatedAt: number | null;
}

/** Channels matching the query, sorted by user count (descending), then name. */
export type ChannelListPage = ChannelListStatus & {
  matched: number;
  channels: ChannelListEntry[];
};

export interface WhoisInfo {
  nick: string;
  found: boolean;
  ident?: string;
  hostname?: string;
  realName?: string;
  account?: string;
  server?: string;
  serverInfo?: string;
  channels?: string;
  away?: string;
  operator?: string;
  secure?: boolean;
  idleSeconds?: number;
  signonTime?: number;
}

export interface BanEntry {
  mask: string;
  setBy: string;
  setAt: number | null;
}

/** User-scoped notification and sidebar choices shared across devices. */
export interface SyncedSettings {
  highlights: string[];
  mutedBuffers: number[];
  mutedNetworks: number[];
  hiddenBuffers: number[];
  collapsedNetworks: number[];
  pushIncludesText: boolean;
  sendTyping: boolean;
}

export interface BufferUnread {
  messages: number;
  mentions: number;
  lastReadId: number;
}

/** Web Push payload decrypted by `public/sw.js`; `bufferId` is null for test notifications. */
export interface PushNotification {
  bufferId: number | null;
  title: string;
  body: string;
}

/** `GET /api/push/key`: the server's VAPID public key (base64url) for `pushManager.subscribe`. */
export interface PushKey {
  publicKey: string;
}

/** `POST /api/push/subscriptions` (from `PushSubscription.toJSON()`); `DELETE` takes only `{ endpoint }`. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type ServerEvent =
  /** `replayed`: backfilled from chathistory; counts as unread but never notifies. */
  | { type: 'message'; message: ChatMessage; replayed?: true }
  | { type: 'buffer'; buffer: ChatBuffer }
  | { type: 'buffer_removed'; bufferId: number }
  | { type: 'history_cleared'; bufferId: number }
  | { type: 'read'; bufferId: number; lastReadId: number }
  | { type: 'network'; networkId: number; status: NetworkStatus }
  | { type: 'network_removed'; networkId: number }
  | { type: 'channel_state'; state: ChannelState }
  | { type: 'channel_list'; status: ChannelListStatus }
  | { type: 'ignores'; networkId: number; ignores: string[] }
  | { type: 'settings'; userId: number; settings: SyncedSettings }
  /** Ephemeral IRCv3 `+typing` notice from `nick`; never stored. */
  | { type: 'typing'; bufferId: number; nick: string; state: TypingState };

/** IRCv3 `+typing` values; `POST /api/buffers/:id/typing` takes `{ state }`. */
export type TypingState = 'active' | 'paused' | 'done';

export interface AccountUser {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

export type AdminUserSummary = AccountUser & {
  disabled: boolean;
  lastLoginAt: number | null;
  networkCount: number;
  connectedCount: number;
  sessionCount: number;
  maxNetworks: number | null;
  retentionDays: number | null;
  /** May upload files to teacup; the admin row starts with it on. `PATCH /api/users/:id { canUpload }`. */
  canUpload: boolean;
};

/** Lifetimes Lingo offers for uploads; teacup's capabilities decide which are available. */
export type UploadExpiry = '1h' | '1d' | '7d' | '30d' | 'permanent';

/**
 * `GET /api/uploads/capabilities` (always 200): what this user may upload right now.
 * `maxBytes` is the smaller of Lingo's and teacup's per-file limits.
 */
export type UploadCapabilities =
  | { enabled: true; maxBytes: number; expiries: UploadExpiry[]; defaultExpiry: UploadExpiry }
  | { enabled: false; reason: 'not_configured' | 'not_permitted' | 'unavailable' };

/** One of the user's uploads; `expiresAt` is null for permanent files. `POST /api/uploads` returns one (201). */
export interface UploadRecord {
  id: number;
  url: string;
  filename: string;
  size: number;
  expiresAt: number | null;
  createdAt: number;
}

/** `GET /api/uploads?before=<id>&limit=<n>`: unexpired uploads, newest first. */
export interface UploadPage {
  uploads: UploadRecord[];
  hasMore: boolean;
}

/** `GET /api/setup`: `required` until the admin account has been created on first login. */
export interface SetupStatus {
  required: boolean;
}

export interface Bootstrap {
  user: AccountUser;
  networks: Network[];
  buffers: ChatBuffer[];
  statuses: Record<number, NetworkStatus>;
  ignores: Record<number, string[]>;
  settings: SyncedSettings;
  unread: Record<number, BufferUnread>;
  /** Whether the user has saved settings; distinguishes defaults from unmigrated local choices. */
  settingsConfigured: boolean;
}
