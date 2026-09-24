declare module 'irc-framework' {
  export interface ClientOptions {
    host: string;
    port: number;
    tls: boolean;
    nick: string;
    username: string;
    gecos: string;
    account?: { account: string; password: string };
    enable_echomessage: boolean;
    auto_reconnect: boolean;
  }

  export interface IrcEvent {
    nick?: string;
    new_nick?: string;
    target?: string;
    channel?: string;
    users?: Array<{ nick: string; modes?: string[] }>;
    kicked?: string;
    topic?: string;
    message?: string;
    time?: number;
    ident?: string;
    hostname?: string;
    modes?: Array<{ mode: string; param?: string }>;
    num_users?: number;
    from_server?: boolean;
    tags?: Record<string, string>;
    /** Set on commands delivered inside an IRCv3 batch, such as a chathistory replay. */
    batch?: { id: string; type: string; params: string[] };
  }

  export interface IrcBatch {
    id: string;
    type: string;
    params: string[];
    commands: Array<{ command: string; params: string[]; tags: Record<string, string> }>;
  }

  export class Client {
    readonly connected: boolean;
    readonly user: { nick: string };
    readonly network: {
      options: { PREFIX: Array<{ symbol: string; mode: string }>; CHATHISTORY?: string | boolean };
      cap: { isEnabled(name: string): boolean };
      /** Whether `message-tags` is enabled and CLIENTTAGDENY allows this client-only tag (name without `+`). */
      supportsTag(name: string): boolean;
    };
    readonly connection: {
      end(data?: string): void;
      clearTimers(): void;
      transport: { disposeSocket(): void } | null;
    };
    connect(options: ClientOptions): void;
    /** Adds capabilities to request on the next connect. */
    requestCap(cap: string | string[]): void;
    on<T = IrcEvent>(event: string, callback: (event: T) => void): this;
    removeAllListeners(): this;
    caseCompare(left: string, right: string): boolean;
    join(channel: string): void;
    part(channel: string): void;
    changeNick(nick: string): void;
    say(target: string, message: string): void;
    notice(target: string, message: string): void;
    action(target: string, message: string): void;
    setTopic(channel: string, topic: string): void;
    tagmsg(target: string, tags: Record<string, string>): void;
    list(mask?: string): void;
    raw(command: string, ...args: string[]): void;
  }
}
