import { Client, type IrcEvent } from 'irc-framework';
import type {
  ChannelState,
  ChannelUser,
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
  channels: Map<string, { topic: string | null; users: Map<string, { nick: string; modes: string[] }> }>;
  listRemaining: number;
  listCount: number;
};

function isChannel(name: string): boolean {
  return /^[#&+!][^\s,\x00-\x1f\x7f]+$/.test(name);
}
function channelsFrom(input: string): string[] {
  const channels = input.split(/[\s,]+/).filter(Boolean);
  if (/^\s*,|,\s*,|,\s*$/.test(input) ||
    !channels.length || channels.length > 20 || channels.some(name => !isChannel(name) || name.length > 100) ||
    new Set(channels.map(name => name.toLowerCase())).size !== channels.length)
    throw new Error('Usage: /join #channel[,#channel]');
  return channels;
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
  private browserPresent = false;

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
      channels: new Map(),
      listRemaining: -1,
      listCount: 0,
    };
    this.connections.set(network.id, runtime);
    this.setStatus(runtime, 'connecting');
    this.serverBuffer(network.id);

    client.on('registered', (event: IrcEvent) => {
      if (!runtime.active || runtime.registered) return;
      runtime.registered = true;
      runtime.retryCount = 0;
      this.setStatus(runtime, 'connected', event.nick || client.user.nick);
      this.connectionMarker(runtime, 'connected');
      this.applyAway(runtime);
      this.onRegistered(runtime);
    });
    client.on('close', () => {
      if (!runtime.active) return;
      if (runtime.registered) this.connectionMarker(runtime, 'disconnected');
      runtime.registered = false;
      this.clearChannels(runtime);
      runtime.joined.clear();
      runtime.listRemaining = -1;
      this.scheduleRetry(runtime, 'Connection lost');
    });
    client.on('privmsg', (event: IrcEvent) => this.incoming(runtime, 'privmsg', event));
    client.on('notice', (event: IrcEvent) => this.incoming(runtime, 'notice', event));
    client.on('action', (event: IrcEvent) => this.incoming(runtime, 'action', event));
    client.on('motd', (event: { motd?: string; error?: string }) => {
      if (!runtime.active || !event.motd) return;
      const buffer = this.serverBuffer(network.id);
      for (const line of event.motd.split(/\r?\n/)) {
        const text = line.replace(/^- /, '');
        if (text) this.message(buffer, 'system', null, text, Date.now(), { fromNetwork: true, isMotd: true });
      }
    });
    client.on('userlist', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !Array.isArray(event.users)) return;
      const key = event.channel.toLowerCase();
      if (!runtime.joined.has(key)) return;
      const state = this.liveChannel(runtime, key);
      state.users.clear();
      for (const user of event.users) {
        if (!user?.nick) continue;
        state.users.set(user.nick.toLowerCase(), { nick: user.nick, modes: [...new Set(user.modes ?? [])] });
      }
      this.publishChannel(runtime, event.channel);
    });
    client.on('join', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.nick) return;
      const key = event.channel.toLowerCase();
      const self = client.caseCompare(event.nick, client.user.nick);
      if (self) {
        runtime.joined.add(key);
        const buffer = this.ensureBuffer(network.id, event.channel, 'channel');
        this.system(buffer, `Joined ${event.channel}`, eventTime(event), true);
        // Some networks omit topic or NAMES from the automatic JOIN burst.
        client.raw('TOPIC', event.channel);
        client.raw('NAMES', event.channel);
      }
      if (!runtime.joined.has(key)) return;
      this.liveChannel(runtime, key).users.set(event.nick.toLowerCase(), { nick: event.nick, modes: [] });
      this.publishChannel(runtime, event.channel);
    });
    client.on('part', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.nick) return;
      const key = event.channel.toLowerCase();
      if (client.caseCompare(event.nick, client.user.nick)) {
        runtime.joined.delete(key);
        this.clearChannel(runtime, key);
      } else if (this.deleteNick(client, runtime.channels.get(key)?.users, event.nick)) {
        this.publishChannel(runtime, event.channel);
      }
    });
    client.on('quit', (event: IrcEvent) => {
      if (!runtime.active || !event.nick) return;
      for (const [channel, state] of runtime.channels) {
        if (this.deleteNick(client, state.users, event.nick)) this.publishChannel(runtime, channel);
      }
    });
    client.on('kick', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || !event.kicked) return;
      const key = event.channel.toLowerCase();
      if (client.caseCompare(event.kicked, client.user.nick)) {
        runtime.joined.delete(key);
        this.clearChannel(runtime, key);
      } else if (this.deleteNick(client, runtime.channels.get(key)?.users, event.kicked)) {
        this.publishChannel(runtime, event.channel);
      }
    });
    client.on('nick', (event: IrcEvent) => {
      if (!runtime.active || !event.nick || !event.new_nick) return;
      for (const [channel, state] of runtime.channels) {
        const user = this.deleteNick(client, state.users, event.nick);
        if (user) {
          state.users.set(event.new_nick.toLowerCase(), { ...user, nick: event.new_nick });
          this.publishChannel(runtime, channel);
        }
      }
      if (client.caseCompare(event.nick, runtime.status.nick)) {
        this.setStatus(runtime, runtime.status.state, event.new_nick);
        this.system(this.serverBuffer(network.id), `You are now known as ${event.new_nick}`, eventTime(event), true);
      }
    });
    client.on('mode', (event: IrcEvent) => {
      if (!runtime.active || !event.target || !event.modes) return;
      const state = runtime.channels.get(event.target.toLowerCase());
      if (!state) return;
      let changed = false;
      for (const change of event.modes) {
        const mode = change.mode?.slice(1);
        if (!mode || !client.network.options.PREFIX.some(prefix => prefix.mode === mode) || !change.param) continue;
        let user: { nick: string; modes: string[] } | undefined;
        for (const entry of state.users.values()) {
          if (client.caseCompare(entry.nick, change.param)) { user = entry; break; }
        }
        if (!user) continue;
        const before = user.modes.includes(mode);
        if (change.mode[0] === '+' && !before) { user.modes.push(mode); changed = true; }
        if (change.mode[0] === '-' && before) {
          user.modes.splice(user.modes.indexOf(mode), 1);
          changed = true;
        }
      }
      if (changed) this.publishChannel(runtime, event.target);
    });
    client.on('topic', (event: IrcEvent) => {
      if (!runtime.active || !event.channel || typeof event.topic !== 'string') return;
      const state = runtime.channels.get(event.channel.toLowerCase());
      if (state && state.topic !== event.topic) {
        state.topic = event.topic;
        this.publishChannel(runtime, event.channel);
      }
      if (event.nick && state) {
        const buffer = this.channelBuffer(network.id, event.channel);
        if (buffer) this.system(buffer, `${event.nick} changed the topic to: ${event.topic || '(none)'}`, eventTime(event), true);
      }
    });
    client.on<IrcEvent[]>('channel list', (entries) => {
      if (!runtime.active || runtime.listRemaining <= 0) return;
      const buffer = this.serverBuffer(network.id);
      for (const entry of entries) {
        if (!runtime.listRemaining) break;
        if (!entry.channel) continue;
        const count = Number.isFinite(entry.num_users) ? entry.num_users : 0;
        const topic = (entry.topic ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 250);
        this.system(buffer, `${entry.channel} — ${count} users${topic ? ` — ${topic}` : ''}`, Date.now(), true);
        runtime.listRemaining--;
        runtime.listCount++;
      }
    });
    client.on('channel list end', () => {
      if (!runtime.active || runtime.listRemaining < 0) return;
      this.system(this.serverBuffer(network.id),
        `LIST complete: ${runtime.listCount} channel${runtime.listCount === 1 ? '' : 's'} shown${runtime.listRemaining === 0 ? ' (limit reached)' : ''}`,
        Date.now());
      runtime.listRemaining = -1;
    });
    client.on('sasl failed', () => {
      if (runtime.active) this.setStatus(runtime, runtime.status.state, undefined, 'SASL authentication failed');
    });

    this.dial(runtime, config);
  }

  disconnect(id: number): void {
    const runtime = this.connections.get(id);
    if (!runtime) return;
    if (runtime.registered) this.connectionMarker(runtime, 'disconnected');
    runtime.active = false;
    runtime.registered = false;
    clearTimeout(runtime.retryTimer ?? undefined);
    this.clearChannels(runtime);
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
  setBrowserPresence(present: boolean): void {
    if (this.browserPresent === present) return;
    this.browserPresent = present;
    for (const runtime of this.connections.values()) this.applyAway(runtime);
  }

  updateAwayMessage(): void {
    if (!this.browserPresent) {
      for (const runtime of this.connections.values()) this.applyAway(runtime);
    }
  }

  private applyAway(runtime: Runtime): void {
    if (!runtime.registered || !runtime.active) return;
    const message = this.browserPresent ? '' : this.store.getAwayMessage();
    runtime.client.raw(message ? `AWAY :${message}` : 'AWAY');
  }

  private connectionMarker(runtime: Runtime, event: 'connected' | 'disconnected'): void {
    const time = Date.now();
    for (const buffer of this.store.listBuffers()) {
      if (buffer.networkId !== runtime.network.id) continue;
      this.message(buffer, 'system', null,
        event === 'connected' ? 'Connected' : 'Disconnected', time, { connectionEvent: event });
    }
  }

  channelState(bufferId: number): ChannelState {
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer || buffer.kind !== 'channel') throw new Error('Channel not found');
    const runtime = this.connections.get(buffer.networkId);
    const state = runtime?.channels.get(buffer.name.toLowerCase());
    const prefixes = runtime?.client.network.options.PREFIX ?? [];
    const users: ChannelUser[] = [...(state?.users.values() ?? [])].map(user => ({
      nick: user.nick,
      modes: [...user.modes],
      prefix: prefixes.find(prefix => user.modes.includes(prefix.mode))?.symbol ?? '',
    }));
    const rank = (user: ChannelUser) => {
      const index = prefixes.findIndex(prefix => prefix.symbol === user.prefix);
      return index < 0 ? prefixes.length : index;
    };
    users.sort((a, b) => rank(a) - rank(b) || a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }));
    return { bufferId, topic: state?.topic ?? null, users };
  }

  setTopic(bufferId: number, topic: string): void {
    if (typeof topic !== 'string' || Buffer.byteLength(topic, 'utf8') > 390 || /[\r\n\0]/.test(topic))
      throw new Error('Invalid topic');
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer || buffer.kind !== 'channel') throw new Error('Channel not found');
    const runtime = this.connections.get(buffer.networkId);
    if (!runtime?.registered || !runtime.joined.has(buffer.name.toLowerCase()) ||
      !runtime.channels.has(buffer.name.toLowerCase())) throw new Error('Channel is not connected');
    runtime.client.setTopic(buffer.name, topic);
  }

  listLiveParticipants(bufferId: number): MentionCandidate[] {
    const buffer = this.store.getBuffer(bufferId);
    if (!buffer || buffer.kind !== 'channel') return [];
    const runtime = this.connections.get(buffer.networkId);
    if (!runtime) return [];
    const users = runtime.channels.get(buffer.name.toLowerCase())?.users;
    if (!users) return [];
    const network = this.store.getNetwork(buffer.networkId) ?? runtime.network;
    const relayNicks = new Set(network.relayNicks.map(nick => nick.toLowerCase()));
    const displayNames = network.displayNames;
    const participants: MentionCandidate[] = [];
    for (const { nick: mention } of users.values()) {
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

  private liveChannel(runtime: Runtime, key: string): { topic: string | null; users: Map<string, { nick: string; modes: string[] }> } {
    let state = runtime.channels.get(key);
    if (!state) {
      state = { topic: null, users: new Map() };
      runtime.channels.set(key, state);
    }
    return state;
  }

  private publishChannel(runtime: Runtime, channel: string): void {
    const buffer = this.channelBuffer(runtime.network.id, channel);
    if (buffer) this.publish({ type: 'channel_state', state: this.channelState(buffer.id) });
  }

  private clearChannel(runtime: Runtime, channel: string): void {
    if (runtime.channels.delete(channel)) this.publishChannel(runtime, channel);
  }

  private clearChannels(runtime: Runtime): void {
    for (const channel of runtime.channels.keys()) this.clearChannel(runtime, channel);
  }

  private deleteNick(client: Client, users: Map<string, { nick: string; modes: string[] }> | undefined,
    nick: string): { nick: string; modes: string[] } | undefined {
    if (!users) return;
    for (const [key, user] of users) {
      if (!client.caseCompare(user.nick, nick)) continue;
      users.delete(key);
      return user;
    }
  }

  forgetBuffer(id: number): void {
    this.knownBuffers.delete(id);
  }

  join(networkId: number, channel: string): void {
    this.joinMany(networkId, [channel]);
  }

  joinMany(networkId: number, channels: string[]): ChatBuffer[] {
    if (!channels.length || channels.length > 20 || channels.some(name => !isChannel(name) || name.length > 100) ||
      new Set(channels.map(name => name.toLowerCase())).size !== channels.length)
      throw new Error('Enter valid, distinct channel names (up to 20)');
    const network = this.store.getNetwork(networkId);
    if (!network) throw new Error('Network not found');
    const runtime = this.connections.get(networkId);
    const saved = new Set(network.autojoin.map(name => name.toLowerCase()));
    const additions = channels.filter(name => !saved.has(name.toLowerCase()));
    if (network.autojoin.length + additions.length > 100) throw new Error('Too many autojoined channels');
    if (additions.length) {
      const updated = this.store.updateNetwork(networkId, {
        ...network, autojoin: [...network.autojoin, ...additions],
      })!;
      if (runtime) runtime.network = updated;
    }
    const buffers = channels.map(channel => this.ensureBuffer(networkId, channel, 'channel'));
    if (runtime?.registered) {
      for (const channel of channels) {
        const key = channel.toLowerCase();
        if (runtime.joined.has(key)) continue;
        runtime.joined.add(key);
        runtime.client.join(channel);
      }
    }
    return buffers;
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
    if (runtime) this.clearChannel(runtime, key);
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
        this.joinMany(runtime.network.id, channelsFrom(args));
        return;
      }
      case 'list': {
        if (args && (args.length > 100 || !safeToken(args))) throw new Error('Usage: /list [mask]');
        if (runtime.listRemaining >= 0) throw new Error('Channel list already in progress');
        runtime.listRemaining = 100;
        runtime.listCount = 0;
        runtime.client.raw('LIST', ...(args ? [args] : []));
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
    // irc-framework parses bare server prefixes such as `:mock` as nick values.
    // A server NOTICE addressed to our nick has no user/host mask, so retain it
    // in the server buffer even when `from_server` is false.
    const serverNotice = kind === 'notice' &&
      runtime.client.caseCompare(event.target, runtime.status.nick) &&
      !event.ident && !event.hostname;
    const fromNetwork = !!event.from_server || serverNotice;
    const name = isChannel(event.target) ? event.target : fromNetwork ? undefined : event.nick;
    const buffer = name
      ? this.ensureBuffer(runtime.network.id, name, isChannel(event.target) ? 'channel' : 'query')
      : this.serverBuffer(runtime.network.id);
    this.message(buffer, kind, event.nick || null, event.message, eventTime(event),
      fromNetwork ? { fromNetwork: true } : {});
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
    metadata: Pick<ChatMessage, 'fromNetwork' | 'connectionEvent' | 'isMotd'> = {},
  ): void {
    const message = this.store.appendMessage({
      networkId: buffer.networkId, bufferId: buffer.id, kind, nick, text, time, ...metadata,
    });
    this.publish({ type: 'message', message });
  }

  private system(buffer: ChatBuffer, text: string, time: number, fromNetwork = false): void {
    this.message(buffer, 'system', null, text, time, fromNetwork ? { fromNetwork: true } : {});
  }

  private setStatus(runtime: Runtime, state: NetworkStatus['state'], nick = runtime.status.nick, error?: string): void {
    runtime.status = { state, nick, ...(error ? { error } : {}) };
    this.statuses.set(runtime.network.id, runtime.status);
    this.publish({ type: 'network', networkId: runtime.network.id, status: { ...runtime.status } });
  }

  private dial(runtime: Runtime, config = this.store.getNetworkConfig(runtime.network.id)): void {
    if (!runtime.active || !config) return;
    this.clearChannels(runtime);
    runtime.joined.clear();
    runtime.listRemaining = -1;
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
