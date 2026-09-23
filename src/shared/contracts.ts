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
}

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

export type ServerEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'buffer'; buffer: ChatBuffer }
  | { type: 'buffer_removed'; bufferId: number }
  | { type: 'network'; networkId: number; status: NetworkStatus }
  | { type: 'network_removed'; networkId: number }
  | { type: 'channel_state'; state: ChannelState };

export interface Bootstrap {
  networks: Network[];
  buffers: ChatBuffer[];
  statuses: Record<number, NetworkStatus>;
}
