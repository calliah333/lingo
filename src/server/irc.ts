import { Client, type IrcEvent } from 'irc-framework';
import type {
  ChatBuffer,
  ChatMessage,
  MentionCandidate,
  Network,
  NetworkStatus,
  ServerEvent,
} from '../shared/contracts.ts';
import type { Store } from './store.ts';

type Runtime = {
  network: Network;
  client: Client;
  status: NetworkStatus;
  active: boolean;
  registered: boolean;
  retryCount: number;
  retryTimer: NodeJS.Timeout | null;
  joined: Set<string>;
  liveUsers: Map<string, Set<string>>;
};

function isChannel(name: string): boolean {
  return /^[#&+!][^\s,\x00-\x1f\x7f]+$/.test(name);
}

function safeToken(value: string): boolean {
  return !!value && !/[:\s,\x00-\x1f\x7f]/.test(value);
}

function safeText(value: string): boolean {
  return !!value.trim() && !/[\r\n\x00]/.test(value);
}

function eventTime(event: IrcEvent): number {
  return typeof event.time === 'number' && Number.isFinite(event.time) && event.time >= 0
    ? event.time : Date.now();
}

export class IrcManager {
  private readonly connections = new Map<number, Runtime>();
  private readonly statuses = new Map<number, NetworkStatus>();
  private readonly knownBuffers = new Set<number>();
  private started = false;

  constructor(
    private readonly store: Store,
    private readonly publish: (event: ServerEvent) => void,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.knownBuffers.clear();
    for (const buffer of this.store.listBuffers()) this.knownBuffers.add(buffer.id);
    for (const network of this.store.listNetworks()) this.connect(network);
  }

  stop(): void {
    this.started = false;
    for (const id of this.connections.keys()) this.disconnect(id);
  }

  connect(network: Network): void {
    const config = this.store.getNetworkConfig(network.id);
    if (!config) throw new Error('Network not found');
    if (this.connections.has(network.id)) this.disconnect(network.id);

    const client = new Client();
    const runtime: Runtime = {
      network,
      client,
      status: { state: 'connecting', nick: network.nick },
      active: true,
      registered: false,
      retryCount: 0,
      retryTimer: null,
      joined: new Set(),
      liveUsers: new Map(),
    };
    this.connections.set(network.id, runtime);
    this.setStatus(runtime, 'connecting');
    this.serverBuffer(network.id);

    client.on('registered', (event: IrcEvent) => {
      if (!runtime.active) return;
      runtime.registered = true;
      runtime.retryCount = 0;
      this.setStatus(runtime, 'connected', event.nick || client.user.nick);
      this.onRegistered(runtime);
    });
    client.on('close', () => {
      if (!runtime.active) return;
      runtime.registered = false;
      this.scheduleRetry(runtime, 'Connection lost');
    });
    client.on('privmsg', (event: IrcEvent) => this.incoming(runtime, 'privmsg', event));
    client.on('notice', (event: IrcEvent) => this.incoming(runtime, 'notice', event));
    client.on('action', (event: IrcEvent) => this.incoming(runtime, 'action', event));
    client.on('userlist', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !Array.isArray(event.users)) return;
      const users = new Set<string>();
      for (const user of event.users) {
        if (user?.nick) users.add(user.nick);
      }
      runtime.liveUsers.set(event.channel.toLowerCase(), users);
    });
    client.on('join', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.nick) return;
      const key = event.channel.toLowerCase();
      const users = runtime.liveUsers.get(key) ?? new Set<string>();
      users.add(event.nick);
      runtime.liveUsers.set(key, users);
      if (!client.caseCompare(event.nick, client.user.nick)) return;
      runtime.joined.add(key);
      const buffer = this.ensureBuffer(network.id, event.channel, 'channel');
      this.system(buffer, `Joined ${event.channel}`, eventTime(event));
    });
    client.on('part', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.nick) return;
      const key = event.channel.toLowerCase();
      const users = runtime.liveUsers.get(key);
      if (users) {
        this.deleteNick(client, users, event.nick);
        if (users.size === 0) runtime.liveUsers.delete(key);
      }
      if (!client.caseCompare(event.nick, client.user.nick)) return;
      runtime.joined.delete(key);
      runtime.liveUsers.delete(key);
    });
    client.on('quit', (event: IrcEvent) => {
      if (!runtime.active || !event.nick) return;
      for (const [channel, users] of runtime.liveUsers) {
        this.deleteNick(client, users, event.nick);
        if (users.size === 0) runtime.liveUsers.delete(channel);
      }
    });
    client.on('kick', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.kicked) return;
      const key = event.channel.toLowerCase();
      const users = runtime.liveUsers.get(key);
      if (users) {
        this.deleteNick(client, users, event.kicked);
        if (users.size === 0) runtime.liveUsers.delete(key);
      }
      if (client.caseCompare(event.kicked, client.user.nick)) {
        runtime.joined.delete(key);
        runtime.liveUsers.delete(key);
      }
    });
    client.on('nick', (event: IrcEvent) => {
      if (!runtime.active || !event.nick || !event.new_nick) return;
      for (const users of runtime.liveUsers.values()) {
        if (this.deleteNick(client, users, event.nick)) users.add(event.new_nick);
      }
      if (client.caseCompare(event.nick, runtime.status.nick)) {
        this.setStatus(runtime, runtime.status.state, event.new_nick);
        const buffer = this.serverBuffer(network.id);
        this.system(buffer, `You are now known as ${event.new_nick}`, eventTime(event));
      }
    });
    client.on('topic', (event: IrcEvent) => {
      if (!runtime.active || !event.nick || !event.channel) return;
      const buffer = this.channelBuffer(network.id, event.channel);
      if (buffer) this.system(buffer, `${event.nick} changed the topic to: ${event.topic || '(none)'}`, eventTime(event));
    });
    client.on('sasl failed', () => {
      if (runtime.active) this.setStatus(runtime, runtime.status.state, undefined, 'SASL authentication failed');
    });

    this.dial(runtime, config);
  }

  disconnect(id: number): void {
    const runtime = this.connections.get(id);
    if (!runtime) return;
    runtime.active = false;
    runtime.registered = false;
    clearTimeout(runtime.retryTimer ?? undefined);
    runtime.retryTimer = null;
    this.connections.delete(id);
    // end() cancels irc-framework's ping/reconnect timers; disposing the transport also
    // closes a TCP connection still in the initial handshake without waiting for close.
    runtime.client.connection.end();
    runtime.client.connection.clearTimers();
    runtime.client.connection.transport?.disposeSocket();
    runtime.client.removeAllListeners();
    this.setStatus(runtime, 'disconnected');
  }

  update(network: Network): void {
    this.connect(network);
  }

  status(): Record<number, NetworkStatus> {
    return Object.fromEntries(this.store.listNetworks().map(network => [
      network.id, { ...(this.statuses.get(network.id) ?? { state: 'disconnected', nick: network.nick }) },
    ]));
  }

  listLiveParticipants(bufferId: number): MentionCandidate[] {
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer || buffer.kind !== 'channel') return [];
    const runtime = this.connections.get(buffer.networkId);
    if (!runtime) return [];
    const users = runtime.liveUsers.get(buffer.name.toLowerCase());
    if (!users) return [];
    const network = this.store.getNetwork(buffer.networkId) ?? runtime.network;
    const relayNicks = new Set(network.relayNicks.map(nick => nick.toLowerCase()));
    const displayNames = network.displayNames;
    const participants: MentionCandidate[] = [];
    for (const mention of users) {
      if (relayNicks.has(mention.toLowerCase())) continue;
      let name = mention;
      for (const source in displayNames) {
        if (Object.hasOwn(displayNames, source) && source.toLowerCase() === mention.toLowerCase() &&
          displayNames[source]?.trim()) {
          name = displayNames[source]!;
          break;
        }
      }
      participants.push({ name, mention });
    }
    return participants;
  }

  private deleteNick(client: Client, users: Set<string>, nick: string): boolean {
    for (const current of users) {
      if (!client.caseCompare(current, nick)) continue;
      users.delete(current);
      return true;
    }
    return false;
  }

  forgetBuffer(id: number): void {
    this.knownBuffers.delete(id);
  }

  join(networkId: number, channel: string): void {
    if (!isChannel(channel)) throw new Error('Enter a valid channel name');
    const network = this.store.getNetwork(networkId);
    if (!network) throw new Error('Network not found');
    const runtime = this.connections.get(networkId);
    this.ensureBuffer(networkId, channel, 'channel');
    const key = channel.toLowerCase();
    if (!network.autojoin.some(name => name.toLowerCase() === key)) {
      const updated = this.store.updateNetwork(networkId, {
        ...network, autojoin: [...network.autojoin, channel],
      })!;
      if (runtime) runtime.network = updated;
    }
    if (runtime?.registered && !runtime.joined.has(key)) {
      runtime.joined.add(key);
      runtime.client.join(channel);
    }
  }

  part(bufferId: number): void {
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer || buffer.kind !== 'channel') throw new Error('Channel not found');
    const network = this.store.getNetwork(buffer.networkId);
    if (!network) throw new Error('Network not found');
    const runtime = this.connections.get(buffer.networkId);
    const key = buffer.name.toLowerCase();
    const autojoin = network.autojoin.filter(channel => channel.toLowerCase() !== key);
    if (autojoin.length !== network.autojoin.length) {
      const updated = this.store.updateNetwork(network.id, { ...network, autojoin })!;
      if (runtime) runtime.network = updated;
    }
    if (runtime?.registered && runtime.joined.has(key)) runtime.client.part(buffer.name);
    runtime?.joined.delete(key);
  }

  send(bufferId: number, text: string): void {
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer) throw new Error('Buffer not found');
    const runtime = this.connections.get(buffer.networkId);
    if (!runtime) throw new Error('Network is not connected');
    if (!safeText(text)) throw new Error('Enter a single-line message');
    if (!runtime.registered && !/^\/(?:join|part)(?:\s|$)/i.test(text))
      throw new Error('Network is not connected');
    this.sendText(runtime, buffer, text, true);
  }

  private sendText(runtime: Runtime, buffer: ChatBuffer, text: string, record: boolean): void {
    if (text.startsWith('//')) {
      this.sendTo(runtime, buffer, 'privmsg', text.slice(1), record);
      return;
    }
    if (!text.startsWith('/')) {
      this.sendTo(runtime, buffer, 'privmsg', text, record);
      return;
    }

    const space = text.indexOf(' ');
    const command = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
    const args = space < 0 ? '' : text.slice(space + 1).trim();
    switch (command) {
      case 'join': {
        if (!isChannel(args)) throw new Error('Usage: /join #channel');
        this.join(runtime.network.id, args);
        return;
      }
      case 'part': {
        let target = buffer;
        if (args) {
          if (!isChannel(args)) throw new Error('Usage: /part [#channel]');
          const found = this.channelBuffer(runtime.network.id, args);
          if (!found) throw new Error('Channel not found');
          target = found;
        }
        this.part(target.id);
        return;
      }
      case 'nick': {
        if (!safeToken(args)) throw new Error('Usage: /nick nickname');
        runtime.client.changeNick(args);
        return;
      }
      case 'me': {
        if (!args) throw new Error('Usage: /me action');
        this.sendTo(runtime, buffer, 'action', args, record);
        return;
      }
      case 'msg':
      case 'notice': {
        const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
        if (!match || !safeToken(match[1]!) || !match[2]!.trim())
          throw new Error(`Usage: /${command} target message`);
        const target = match[1]!;
        const recipient = this.ensureBuffer(runtime.network.id, target,
          isChannel(target) ? 'channel' : 'query');
        this.sendTo(runtime, recipient, command === 'msg' ? 'privmsg' : 'notice', match[2]!, record);
        return;
      }
      case 'topic': {
        let channel = buffer.kind === 'channel' ? buffer.name : '';
        let topic = args;
        if (isChannel(args.split(/\s/, 1)[0] || '')) {
          const split = args.indexOf(' ');
          channel = split < 0 ? args : args.slice(0, split);
          topic = split < 0 ? '' : args.slice(split + 1).trim();
        }
        if (!channel) throw new Error('Usage: /topic #channel [topic]');
        if (topic) runtime.client.setTopic(channel, topic);
        else runtime.client.raw(`TOPIC ${channel}`);
        return;
      }
      default:
        throw new Error('Unknown command');
    }
  }

  private sendTo(
    runtime: Runtime,
    buffer: ChatBuffer,
    kind: 'privmsg' | 'notice' | 'action',
    text: string,
    record: boolean,
  ): void {
    if (buffer.kind === 'server' || !safeToken(buffer.name) || !safeText(text))
      throw new Error('Select a channel or conversation');
    if (kind === 'privmsg') runtime.client.say(buffer.name, text);
    else if (kind === 'notice') runtime.client.notice(buffer.name, text);
    else runtime.client.action(buffer.name, text);
    if (record) this.message(buffer, kind, runtime.status.nick, text, Date.now());
  }

  private onRegistered(runtime: Runtime): void {
    for (const channel of runtime.network.autojoin) {
      if (!isChannel(channel)) continue;
      const key = channel.toLowerCase();
      if (runtime.joined.has(key)) continue;
      this.ensureBuffer(runtime.network.id, channel, 'channel');
      runtime.joined.add(key);
      runtime.client.join(channel);
    }
    for (const command of runtime.network.commands) {
      if (!safeText(command)) continue;
      const line = command.trim();
      // Configured commands may contain authentication secrets: never store or log them.
      // Slash commands share the interactive parser, but deliberately bypass history.
      if (line.startsWith('/')) {
        if (/^\/(?:msg|notice|join|part|nick|me|topic)(?:\s|$)/i.test(line)) {
          try {
            this.sendText(runtime, this.serverBuffer(runtime.network.id), line, false);
          } catch { /* Ignore invalid configured commands without printing their contents. */ }
        } else if (/^\/[a-z][a-z0-9]*(?:\s|$)/i.test(line)) {
          runtime.client.raw(line.slice(1));
        }
      } else if (/^[a-z][a-z0-9]*(?:\s|$)/i.test(line)) {
        runtime.client.raw(line);
      }
    }
  }

  private incoming(runtime: Runtime, kind: 'privmsg' | 'notice' | 'action', event: IrcEvent): void {
    if (!runtime.active || !event.message || !event.target) return;
    if (event.nick && runtime.client.caseCompare(event.nick, runtime.status.nick)) return;
    const name = isChannel(event.target) ? event.target : event.nick;
    const buffer = name
      ? this.ensureBuffer(runtime.network.id, name, isChannel(event.target) ? 'channel' : 'query')
      : this.serverBuffer(runtime.network.id);
    this.message(buffer, kind, event.nick || null, event.message, eventTime(event));
  }

  private ensureBuffer(networkId: number, name: string, kind: ChatBuffer['kind']): ChatBuffer {
    const buffer = this.store.getOrCreateBuffer(networkId, name, kind);
    if (!this.knownBuffers.has(buffer.id)) {
      this.knownBuffers.add(buffer.id);
      this.publish({ type: 'buffer', buffer });
    }
    return buffer;
  }

  private serverBuffer(networkId: number): ChatBuffer {
    const existing = this.store.listBuffers().find(buffer =>
      buffer.networkId === networkId && buffer.kind === 'server');
    return existing ?? this.ensureBuffer(networkId, this.connections.get(networkId)!.network.name, 'server');
  }

  private channelBuffer(networkId: number, channel: string): ChatBuffer | undefined {
    return this.store.listBuffers().find(buffer => buffer.networkId === networkId &&
      buffer.kind === 'channel' && buffer.name.toLowerCase() === channel.toLowerCase());
  }


  private message(
    buffer: ChatBuffer,
    kind: ChatMessage['kind'],
    nick: string | null,
    text: string,
    time: number,
  ): void {
    const message = this.store.appendMessage({
      networkId: buffer.networkId, bufferId: buffer.id, kind, nick, text, time,
    });
    this.publish({ type: 'message', message });
  }

  private system(buffer: ChatBuffer, text: string, time: number): void {
    this.message(buffer, 'system', null, text, time);
  }


  private setStatus(runtime: Runtime, state: NetworkStatus['state'], nick = runtime.status.nick, error?: string): void {
    runtime.status = { state, nick, ...(error ? { error } : {}) };
    this.statuses.set(runtime.network.id, runtime.status);
    this.publish({ type: 'network', networkId: runtime.network.id, status: { ...runtime.status } });
  }

  private dial(runtime: Runtime, config = this.store.getNetworkConfig(runtime.network.id)): void {
    if (!runtime.active || !config) return;
    runtime.joined.clear();
    runtime.liveUsers.clear();
    this.setStatus(runtime, runtime.retryCount ? 'reconnecting' : 'connecting');
    try {
      runtime.client.connect({
        host: config.host,
        port: config.port,
        tls: config.tls,
        nick: config.nick,
        username: config.username,
        gecos: config.realname,
        ...(config.saslAccount && config.saslPassword
          ? { account: { account: config.saslAccount, password: config.saslPassword } }
          : {}),
        enable_echomessage: false,
        auto_reconnect: false,
      });
    } catch {
      this.scheduleRetry(runtime, 'Connection failed');
    }
  }

  private scheduleRetry(runtime: Runtime, error: string): void {
    if (!runtime.active || runtime.retryTimer) return;
    this.setStatus(runtime, 'reconnecting', runtime.status.nick, error);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(runtime.retryCount++, 5));
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null;
      this.dial(runtime);
    }, delay);
  }
}
