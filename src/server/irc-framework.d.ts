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
    users?: Array<{ nick: string }>;
    kicked?: string;
    topic?: string;
    message?: string;
    time?: number;
    from_server?: boolean;
  }

  export class Client {
    readonly connected: boolean;
    readonly user: { nick: string };
    readonly connection: {
      end(data?: string): void;
      clearTimers(): void;
      transport: { disposeSocket(): void } | null;
    };
    connect(options: ClientOptions): void;
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
    raw(command: string, ...args: string[]): void;
  }
}
