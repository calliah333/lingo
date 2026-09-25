import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { expect, test } from 'bun:test';
import { createApp } from '../src/server/app.ts';
import { IrcManager } from '../src/server/irc.ts';
import { Store } from '../src/server/store.ts';
import type { Network, ServerEvent } from '../src/shared/contracts.ts';
import type { PushNotifier } from '../src/server/push.ts';

const channel = '#history';
const messageText = 'An indexed message survives channel departure';

type Connection = {
  socket: Socket;
  lines: string[];
  pending: string;
  nick: string;
  hasUser: boolean;
  capEnded: boolean;
  welcomed: boolean;
};

function waitFor(updates: EventEmitter, condition: () => boolean, description: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const finish = (error?: unknown) => {
    clearTimeout(timeout);
    updates.off('change', check);
    if (error) reject(error);
    else resolve();
  };
  const check = () => {
    try {
      if (condition()) finish();
    } catch (error) {
      finish(error);
    }
  };
  // A real TCP peer needs a deadline; this watchdog never delays a successful event.
  const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${description}`)), 5_000);
  updates.on('change', check);
  check();
  return promise;
}

test('part preserves indexed channel history and prevents rejoin on restart', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  let delivered = false;
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    const connectionIndex = connections.push(connection) - 1;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        if (line.startsWith('CAP LS ')) {
          socket.write(':mock CAP * LS :\r\n');
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        } else if (line === `JOIN ${channel}`) {
          socket.write(`:${connection.nick}!user@mock JOIN :${channel}\r\n`);
          if (!delivered) {
            delivered = true;
            socket.write(`:alice!user@mock PRIVMSG ${channel} :${messageText}\r\n`);
            socket.write(`:bob!user@mock PRIVMSG ${channel} :tester, are you here?\r\n`);
            socket.write(`:carol!user@mock PRIVMSG ${channel} :the magic phrase is here\r\n`);
          }
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\nPING :barrier-${connectionIndex}\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const network = store.createNetwork(store.createUser('tester', 'unused')!.id, {
      name: 'mock', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: [channel], commands: [],
      relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    });
    store.patchSettings(store.networkOwner(network.id)!, { highlights: ['magic phrase'] });
    manager.start();
    await waitFor(updates, () => connections[0]?.lines.includes(`JOIN ${channel}`) ?? false, 'initial autojoin');
    await waitFor(updates, () => store.searchMessages(messageText, { networkId: network.id }).messages
      .some(message => message.text === messageText), 'incoming message to be indexed');
    await waitFor(updates, () => store.getMessages(store.getOrCreateBuffer(network.id, channel, 'channel').id)
      .messages.some(message => message.text === 'the magic phrase is here'), 'highlight phrase delivery');

    const buffer = store.getOrCreateBuffer(network.id, channel, 'channel');
    const original = store.searchMessages(messageText, { bufferId: buffer.id }).messages
      .find(message => message.text === messageText);
    expect(original).toMatchObject({ bufferId: buffer.id, networkId: network.id, nick: 'alice', kind: 'privmsg' });
    const highlighted = store.getMessages(buffer.id).messages.filter(message => message.highlight);
    expect(highlighted.map(message => message.text)).toEqual([
      'tester, are you here?', 'the magic phrase is here',
    ]);
    expect(store.getUnread(store.networkOwner(network.id)!)[buffer.id])
      .toMatchObject({ messages: 4, mentions: 2 });

    manager.part(buffer.id);
    await waitFor(updates, () => connections[0]?.lines.some(line => line === `PART ${channel}`) ?? false, 'PART command');
    expect(store.getBuffer(buffer.id)).toEqual(buffer);
    expect(store.getNetwork(network.id)?.autojoin).not.toContain(channel);
    expect(store.searchMessages(messageText, { bufferId: buffer.id }).messages).toContainEqual(original!);

    manager.stop();
    manager.start();
    await waitFor(updates, () => connections[1]?.lines.some(line => /^PONG :?barrier-1$/.test(line)) ?? false,
      'registration and PONG on restarted connection');
    // PONG follows processing of the welcome numeric, so any automatic JOIN precedes it.
    expect(connections[1]!.lines.some(line => line === `JOIN ${channel}`)).toBe(false);
    expect(store.searchMessages(messageText, { bufferId: buffer.id }).messages).toContainEqual(original!);

    manager.join(network.id, channel);
    await waitFor(updates, () => connections[1]!.lines.includes(`JOIN ${channel}`), 'explicit rejoin');
    expect(store.getNetwork(network.id)?.autojoin).toContain(channel);
    expect(store.getOrCreateBuffer(network.id, channel, 'channel').id).toBe(buffer.id);
    expect(store.searchMessages(messageText, { bufferId: buffer.id }).messages).toContainEqual(original!);
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('tracks away presence and persists server-origin and connection events', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    const connectionIndex = connections.push(connection) - 1;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        if (line.startsWith('CAP LS ')) {
          socket.write(':mock CAP * LS :\r\n');
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(
            `:mock 001 ${connection.nick} :Welcome\r\n` +
            `:mock 375 ${connection.nick} :- mock Message of the day -\r\n` +
            `:mock 372 ${connection.nick} :- Be kind to one another\r\n` +
            `:mock 376 ${connection.nick} :End of MOTD\r\n` +
            `:mock NOTICE ${connection.nick} :Network notice retained\r\n` +
            `PING :barrier-${connectionIndex}\r\n`,
          );
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const userId = store.createUser('tester', 'unused')!.id;
    const network = store.createNetwork(userId, {
      name: 'presence', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: [], commands: [],
      relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    });
    const serverBuffer = store.getOrCreateBuffer(network.id, 'server', 'server');
    manager.start();

    await waitFor(updates, () => connections[0]?.lines.includes('AWAY :Away') ?? false, 'automatic AWAY after registration');
    await waitFor(updates, () => store.getMessages(serverBuffer.id).messages.some(message =>
      message.text === 'Be kind to one another' && message.isMotd && message.fromNetwork),
    'network MOTD to be retained with metadata');
    await waitFor(updates, () => store.getMessages(serverBuffer.id).messages.some(message =>
      message.text === 'Network notice retained' && message.kind === 'notice' &&
      message.nick === 'mock' && message.fromNetwork),
    'server NOTICE to be retained with provenance');
    await waitFor(updates, () => store.getMessages(serverBuffer.id).messages.some(message =>
      message.text === 'Connected' && message.connectionEvent === 'connected'),
    'connected marker to be retained');

    manager.setBrowserPresence(new Set([userId]));
    await waitFor(updates, () => connections[0]?.lines.filter(line => line === 'AWAY').length === 1,
      'AWAY clear when browser is present');
    manager.setBrowserPresence(new Set());
    await waitFor(updates, () => connections[0]?.lines.filter(line => line === 'AWAY :Away').length === 2,
      'AWAY reapplied when browser is absent');

    connections[0]!.socket.destroy();
    await waitFor(updates, () => store.getMessages(serverBuffer.id).messages.some(message =>
      message.text === 'Disconnected' && message.connectionEvent === 'disconnected'),
    'disconnected marker to be retained');
    await waitFor(updates, () => store.getMessages(serverBuffer.id).messages.filter(message =>
      message.text === 'Connected' && message.connectionEvent === 'connected').length === 2,
    'connected marker to be retained after reconnect');
    await waitFor(updates, () => connections[1]?.lines.includes('AWAY :Away') ?? false,
      'automatic AWAY reapplied after reconnect');
    expect(store.getMessages(serverBuffer.id).messages.find(message =>
      message.text === 'Be kind to one another')).toMatchObject({
      bufferId: serverBuffer.id, networkId: network.id, kind: 'system',
      fromNetwork: true, isMotd: true,
    });
    expect(store.getMessages(serverBuffer.id).messages.find(message =>
      message.text === 'Network notice retained')).toMatchObject({
      bufferId: serverBuffer.id, networkId: network.id, kind: 'notice', nick: 'mock', fromNetwork: true,
    });
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('ranks LIST results, drops ignored senders, answers WHOIS, and keeps user disconnects', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    const connectionIndex = connections.push(connection) - 1;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        const nick = connection.nick;
        if (line.startsWith('CAP LS ')) socket.write(':mock CAP * LS :\r\n');
        else if (line.startsWith('NICK ')) connection.nick = line.slice('NICK '.length);
        else if (line.startsWith('USER ')) connection.hasUser = true;
        else if (line === 'CAP END') connection.capEnded = true;
        else if (line === 'LIST') {
          socket.write(`:mock 321 ${nick} Channel :Users Name\r\n` +
            `:mock 322 ${nick} #small 3 :about linux\r\n` +
            `:mock 322 ${nick} #linux 900 :kernel talk\r\n` +
            `:mock 322 ${nick} #rust 40 :\r\n` +
            `:mock 322 ${nick} #linguistics 40 :words\r\n` +
            `:mock 323 ${nick} :End of /LIST\r\n`);
        } else if (line === 'WHOIS alice') {
          socket.write(`:mock 311 ${nick} alice ident example.org * :Alice Example\r\n` +
            `:mock 318 ${nick} alice :End of /WHOIS list.\r\n`);
        } else if (line === 'WHOIS ghost') {
          socket.write(`:mock 401 ${nick} ghost :No such nick\r\n:mock 318 ${nick} ghost :End of /WHOIS list.\r\n`);
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\nPING :barrier-${connectionIndex}\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const network = store.createNetwork(store.createUser('tester', 'unused')!.id, {
      name: 'actions', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: [], commands: [],
      relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    });
    manager.start();
    await waitFor(updates, () => connections[0]?.lines.some(line => /^PONG :?barrier-0$/.test(line)) ?? false, 'registration');

    manager.requestChannelList(network.id);
    expect(() => manager.requestChannelList(network.id)).toThrow('Channel list already in progress');
    await waitFor(updates, () => manager.channelList(network.id, '', 10, false).state === 'complete', 'LIST completion');
    expect(manager.channelList(network.id, '', 10, false).channels.map(channel => channel.name))
      .toEqual(['#linux', '#linguistics', '#rust', '#small']);
    const byName = manager.channelList(network.id, 'lin', 1, true);
    expect(byName.matched).toBe(2);
    expect(byName.channels).toEqual([{ name: '#linux', users: 900, topic: 'kernel talk' }]);
    expect(manager.channelList(network.id, 'linux', 10, false).channels.map(channel => channel.name))
      .toEqual(['#linux', '#small']);

    manager.setIgnored(network.id, 'Spammer', true);
    connections[0]!.socket.write(':spammer!s@host PRIVMSG tester :buy now\r\n:alice!a@host PRIVMSG tester :hello\r\n');
    await waitFor(updates, () => store.listBuffers().some(buffer => buffer.kind === 'query' && buffer.name === 'alice'),
      'message after the ignored one');
    expect(store.listBuffers().some(buffer => buffer.name === 'spammer')).toBe(false);
    expect(store.searchMessages('buy', { networkId: network.id }).messages).toEqual([]);

    expect(await manager.whois(network.id, 'alice')).toMatchObject({
      nick: 'alice', found: true, ident: 'ident', hostname: 'example.org', realName: 'Alice Example',
    });
    expect(await manager.whois(network.id, 'ghost')).toMatchObject({ nick: 'ghost', found: false });

    manager.setConnected(network.id, false);
    expect(manager.status()[network.id]?.state).toBe('disconnected');
    manager.stop();
    manager.start();
    // A user-disconnected network stays offline across restarts instead of dialing.
    expect(manager.status()[network.id]?.state).toBe('disconnected');
    manager.setConnected(network.id, true);
    await waitFor(updates, () => connections[1]?.lines.some(line => /^PONG :?barrier-1$/.test(line)) ?? false,
      'reconnect after explicit connect');
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('stores echoed own lines once with server time, drops configured-command echoes, and de-duplicates msgids', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  const serverTime = '2020-01-02T03:04:05.000Z';
  let msgids = 0;
  const peer = (echo: boolean) => createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        if (line.startsWith('CAP LS ')) {
          socket.write(`:mock CAP * LS :${echo ? 'echo-message message-tags server-time' : ''}\r\n`);
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        } else if (echo && /^(?:PRIVMSG|NOTICE) /.test(line)) {
          socket.write(`@msgid=m${++msgids};time=${serverTime} :${connection.nick}!user@mock ${line}\r\n`);
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const servers = [peer(true), peer(false)];
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const userId = store.createUser('tester', 'unused')!.id;
    const networks: Network[] = [];
    for (const [index, server] of servers.entries()) {
      const listening = Promise.withResolvers<void>();
      server.once('error', listening.reject);
      server.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      server.off('error', listening.reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
      networks.push(store.createNetwork(userId, {
        name: `net${index}`, host: '127.0.0.1', port: address.port, tls: false,
        nick: 'tester', username: 'tester', realname: 'Test User',
        saslAccount: '', autojoin: [], commands: ['/msg NickServ IDENTIFY hunter2'],
        relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
      }));
    }
    manager.start();
    await waitFor(updates, () => networks.every(network => manager.status()[network.id]?.state === 'connected'),
      'both networks to register');

    const [echoing, plain] = networks.map(network => store.getOrCreateBuffer(network.id, 'bob', 'query'));
    const lines = (bufferId: number, text: string) =>
      store.getMessages(bufferId).messages.filter(message => message.text === text);
    manager.send(echoing!.id, 'hello');
    // Local recording would be synchronous; with echo-message nothing is stored until the echo arrives.
    expect(lines(echoing!.id, 'hello')).toEqual([]);
    await waitFor(updates, () => lines(echoing!.id, 'hello').length > 0, 'echoed line');
    const [echoed] = lines(echoing!.id, 'hello');
    expect(lines(echoing!.id, 'hello')).toHaveLength(1);
    expect(echoed).toMatchObject({ nick: 'tester', kind: 'privmsg', time: Date.parse(serverTime) });
    expect(store.getUnread(userId)[echoing!.id]).toMatchObject({ messages: 0, lastReadId: echoed!.id });

    manager.send(plain!.id, 'hello');
    expect(lines(plain!.id, 'hello')).toHaveLength(1);
    expect(lines(plain!.id, 'hello')[0]!.time).toBeGreaterThan(Date.parse(serverTime));
    // The configured IDENTIFY was echoed before `hello`, so it has been processed by now.
    expect(connections[0]!.lines).toContain('PRIVMSG NickServ :IDENTIFY hunter2');
    expect(store.searchMessages('hunter2', {}).messages).toEqual([]);

    connections[0]!.socket.write('@msgid=dup :alice!a@mock PRIVMSG tester :once\r\n' +
      '@msgid=dup :alice!a@mock PRIVMSG tester :once\r\n:alice!a@mock PRIVMSG tester :after\r\n');
    const alice = () => store.listBuffers().find(buffer => buffer.networkId === networks[0]!.id && buffer.name === 'alice');
    await waitFor(updates, () => !!alice() && lines(alice()!.id, 'after').length > 0, 'messages after the duplicate');
    expect(lines(alice()!.id, 'once')).toHaveLength(1);
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    for (const server of servers) {
      if (!server.listening) continue;
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('backfills missed channel and private history once, without pushes or configured-command lines', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  const time = (second: number) => `2020-01-01T00:00:0${second}.000Z`;
  const batch = (id: string, type: string, lines: string[]) =>
    [`BATCH +${id} ${type}`, ...lines.map(line => `@batch=${id};${line}`), `BATCH -${id}`].map(line => `${line}\r\n`).join('');
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        const nick = connection.nick;
        if (line.startsWith('CAP LS ')) {
          socket.write(':mock CAP * LS :draft/chathistory batch message-tags server-time\r\n');
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        } else if (line.startsWith('JOIN ')) {
          socket.write(`:${nick}!u@mock JOIN ${line.slice('JOIN '.length)}\r\n`);
        } else if (line.startsWith(`CHATHISTORY AFTER #room timestamp=${time(1)} `)) {
          socket.write(batch('b1', 'chathistory #room', [
            `msgid=old;time=${time(0)} :bob!b@mock PRIVMSG #room :already stored`,
            `time=${time(1)} :bob!b@mock PRIVMSG #room :plain stored`,
            `msgid=new1;time=${time(2)} :bob!b@mock PRIVMSG #room :${nick}: missed mention`,
            `msgid=own1;time=${time(3)} :${nick}!u@mock PRIVMSG #room :my missed line`,
          ]));
        } else if (line.startsWith(`CHATHISTORY AFTER #room timestamp=${time(3)} `)) {
          socket.write(batch('b2', 'chathistory #room', [`msgid=new2;time=${time(4)} :bob!b@mock PRIVMSG #room :page two`]));
        } else if (line.startsWith('CHATHISTORY TARGETS ')) {
          socket.write(batch('t1', 'draft/chathistory-targets', ['alice', 'NickServ', '#room']
            .map(target => `time=${time(5)} :mock CHATHISTORY TARGETS ${target} ${time(5)}`)));
        } else if (line.startsWith(`CHATHISTORY AFTER alice timestamp=${time(1)} `)) {
          socket.write(batch('p1', 'chathistory alice', [
            `msgid=pm1;time=${time(5)} :alice!a@mock PRIVMSG ${nick} :while you were away`,
          ]));
        } else if (line.startsWith('CHATHISTORY AFTER NickServ ')) {
          socket.write(batch('n1', 'chathistory NickServ', [
            `msgid=ns1;time=${time(5)} :${nick}!u@mock PRIVMSG NickServ :IDENTIFY hunter2`,
            `msgid=ns2;time=${time(6)} :NickServ!s@services NOTICE ${nick} :You are now identified`,
          ]));
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\n:mock 005 ${connection.nick} CHATHISTORY=4 :are supported\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const store = new Store(':memory:');
  const events: ServerEvent[] = [];
  const pushes: Array<{ bufferId: number }> = [];
  const push = { notify: (_userId: number, notification: { bufferId: number }) => { pushes.push(notification); } };
  const manager = new IrcManager(store, (event) => {
    events.push(event);
    updates.emit('change');
  }, push as unknown as PushNotifier);
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const userId = store.createUser('tester', 'unused')!.id;
    const input = {
      name: 'net', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: ['#room'], commands: ['/msg NickServ IDENTIFY hunter2'],
      relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    };
    const network = store.createNetwork(userId, input);
    const room = store.getOrCreateBuffer(network.id, '#room', 'channel');
    const stored = { networkId: network.id, bufferId: room.id, kind: 'privmsg' as const, nick: 'bob' };
    store.appendUniqueMessage({ ...stored, text: 'already stored', time: Date.parse(time(0)) }, 'old');
    store.appendMessage({ ...stored, text: 'plain stored', time: Date.parse(time(1)) });

    manager.start();
    const texts = (bufferId: number) => store.getMessages(bufferId).messages
      .filter(message => message.kind !== 'system').map(message => message.text);
    const query = (name: string) => store.listBuffers().find(buffer => buffer.networkId === network.id && buffer.name === name);
    await waitFor(updates, () => texts(room.id).includes('page two') && !!query('alice') &&
      texts(query('NickServ')?.id ?? 0).includes('You are now identified'), 'replayed history');

    // The full first page is continued after its newest line; the short second page ends the backfill.
    expect(connections[0]!.lines.filter(line => line.startsWith('CHATHISTORY AFTER #room'))).toEqual([
      `CHATHISTORY AFTER #room timestamp=${time(1)} 4`, `CHATHISTORY AFTER #room timestamp=${time(3)} 4`,
    ]);
    expect(connections[0]!.lines.some(line => line.startsWith(`CHATHISTORY TARGETS timestamp=${time(1)} timestamp=`))).toBe(true);
    expect(texts(room.id)).toEqual(['already stored', 'plain stored', 'tester: missed mention', 'my missed line', 'page two']);
    const messages = store.getMessages(room.id).messages;
    expect(messages.find(message => message.text === 'tester: missed mention')).toMatchObject({ highlight: true });
    // The replayed own line is ours: stored with its server time and read up to it.
    const own = messages.find(message => message.text === 'my missed line')!;
    expect(own).toMatchObject({ nick: 'tester', time: Date.parse(time(3)) });
    expect(store.getUnread(userId)[room.id]).toMatchObject({ lastReadId: own.id, messages: 1, mentions: 0 });
    expect(texts(query('alice')!.id)).toEqual(['while you were away']);
    expect(store.searchMessages('hunter2', {}).messages).toEqual([]);
    expect(pushes).toEqual([]);
    const replayedTexts = events.flatMap(event => event.type === 'message' && event.replayed ? [event.message.text] : []);
    expect(replayedTexts).toContain('while you were away');
    expect(replayedTexts).toContain('tester: missed mention');

    // Live lines still notify, so the absence above is due to replay.
    connections[0]!.socket.write(':alice!a@mock PRIVMSG tester :live ping\r\n');
    await waitFor(updates, () => texts(query('alice')!.id).includes('live ping'), 'live private message');
    expect(pushes).toMatchObject([{ bufferId: query('alice')!.id }]);

    // With backfill off, joining sends no CHATHISTORY request.
    const quiet = store.createNetwork(userId, { ...input, name: 'quiet', commands: [], backfill: false });
    manager.connect(quiet);
    await waitFor(updates, () => store.listBuffers().some(buffer => buffer.networkId === quiet.id && buffer.name === '#room' &&
      store.getMessages(buffer.id).messages.some(message => message.text === 'Joined #room')), 'join without backfill');
    expect(connections[1]!.lines.filter(line => line.startsWith('CHATHISTORY'))).toEqual([]);
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('relays +typing: inbound TAGMSGs become owner events, POSTs send TAGMSGs only when opted in', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        if (line.startsWith('CAP LS ')) {
          socket.write(':mock CAP * LS :message-tags server-time\r\n');
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        } else if (line.startsWith('JOIN ')) {
          socket.write(`:${connection.nick}!u@mock JOIN ${line.slice('JOIN '.length)}\r\n`);
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const store = new Store(':memory:');
  const events: ServerEvent[] = [];
  const manager = new IrcManager(store, (event) => {
    events.push(event);
    updates.emit('change');
  });
  const { app } = createApp(store, manager, { setupToken: 'token' });
  const call = (path: string, options: { method?: string; cookie?: string; body?: unknown } = {}) =>
    Promise.resolve(app.request(`http://lingo.test${path}`, {
      method: options.method ?? 'GET',
      headers: {
        host: 'lingo.test', origin: 'http://lingo.test', 'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }));
  const cookieOf = (response: Response) => {
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const password = 'correct horse battery staple';
  try {
    const admin = cookieOf(await call('/api/setup', {
      method: 'POST', body: { username: 'root', password, token: 'token' },
    }));
    expect((await call('/api/users', { method: 'POST', cookie: admin, body: { username: 'bob', password } })).status)
      .toBe(201);
    const bob = cookieOf(await call('/api/login', { method: 'POST', body: { username: 'bob', password } }));
    const adminId = store.listUsers().find(user => user.username === 'root')!.id;

    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const network = store.createNetwork(adminId, {
      name: 'net', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: ['#room'], commands: [],
      relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    });
    manager.start();
    const room = store.getOrCreateBuffer(network.id, '#room', 'channel');
    await waitFor(updates, () => store.getMessages(room.id).messages.some(message => message.text === 'Joined #room'),
      'channel join');

    // Strangers' PMs, ignored nicks, and unknown states produce nothing; typing never creates a buffer.
    manager.setIgnored(network.id, 'mallory', true);
    connections[0]!.socket.write('@+typing=active :carol!c@mock TAGMSG tester\r\n' +
      '@+typing=active :mallory!m@mock TAGMSG #room\r\n@+typing=bogus :alice!a@mock TAGMSG #room\r\n' +
      '@+typing=active :alice!a@mock TAGMSG #room\r\n');
    const typingEvents = () => events.filter(event => event.type === 'typing');
    await waitFor(updates, () => typingEvents().length > 0, 'typing event');
    expect(typingEvents()).toEqual([{ type: 'typing', bufferId: room.id, nick: 'alice', state: 'active' }]);
    expect(store.listBuffers().some(buffer => buffer.name === 'carol')).toBe(false);

    const typing = (cookie: string, state: string) =>
      call(`/api/buffers/${room.id}/typing`, { method: 'POST', cookie, body: { state } });
    expect((await typing(admin, 'active')).status).toBe(200);
    expect((await typing(bob, 'active')).status).toBe(404);
    expect((await typing(admin, 'typing')).status).toBe(400);
    store.patchSettings(adminId, { sendTyping: true });
    expect((await typing(admin, 'active')).status).toBe(200);
    // An identical state within the repeat window is not sent again.
    expect((await typing(admin, 'active')).status).toBe(200);
    expect((await typing(admin, 'done')).status).toBe(200);
    const tagmsgs = () => connections[0]!.lines.filter(line => line.includes('TAGMSG'));
    await waitFor(updates, () => tagmsgs().some(line => line.includes('done')), 'outbound TAGMSG');
    // Sent only after opting in, although the first POST was accepted.
    expect(tagmsgs()).toEqual(['@+typing=active TAGMSG #room', '@+typing=done TAGMSG #room']);
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('falls back from a taken nick, regains it through NickServ with SASL, and delays autojoin', async () => {
  const updates = new EventEmitter();
  const connections: Array<Connection & { welcomedAt: number; joinedAt: number }> = [];
  const peer = (sasl: boolean) => createServer(socket => {
    const connection = {
      socket, lines: [] as string[], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
      welcomedAt: 0, joinedAt: 0,
    };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        if (line.startsWith('CAP LS ')) {
          socket.write(`:mock CAP * LS :${sasl ? 'sasl' : ''}\r\n`);
        } else if (line.startsWith('CAP REQ :')) {
          socket.write(`:mock CAP * ACK :${line.slice('CAP REQ :'.length)}\r\n`);
        } else if (line === 'AUTHENTICATE PLAIN') {
          socket.write('AUTHENTICATE +\r\n');
        } else if (line.startsWith('AUTHENTICATE ')) {
          socket.write(':mock 900 * * tester :You are now logged in as tester\r\n' +
            ':mock 903 * :SASL authentication successful\r\n');
        } else if (line === 'NICK tester') {
          // Another client holds the configured nick.
          socket.write(':mock 433 * tester :Nickname is already in use\r\n');
        } else if (line.startsWith('NICK ')) {
          connection.nick = line.slice('NICK '.length);
        } else if (line.startsWith('USER ')) {
          connection.hasUser = true;
        } else if (line === 'CAP END') {
          connection.capEnded = true;
        } else if (line === 'PRIVMSG NickServ :REGAIN tester') {
          socket.write(`:${connection.nick}!user@mock NICK :tester\r\n`);
          connection.nick = 'tester';
        } else if (line === 'JOIN #room') {
          connection.joinedAt = Date.now();
          socket.write(`:${connection.nick}!user@mock JOIN :#room\r\n`);
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          connection.welcomedAt = Date.now();
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\n`);
        }
        updates.emit('change');
      }
    });
    updates.emit('change');
  });
  const servers = [peer(true), peer(false)];
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const userId = store.createUser('tester', 'unused')!.id;
    const networks: Network[] = [];
    for (const [index, server] of servers.entries()) {
      const listening = Promise.withResolvers<void>();
      server.once('error', listening.reject);
      server.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      server.off('error', listening.reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
      // Both ask to regain the nick, but only the first has a SASL account to regain it with.
      networks.push(store.createNetwork(userId, {
        name: `net${index}`, host: '127.0.0.1', port: address.port, tls: false,
        nick: 'tester', username: 'tester', realname: 'Test User',
        saslAccount: index === 0 ? 'tester' : '', saslPassword: index === 0 ? 'hunter2' : '',
        autojoin: ['#room'], commands: [], relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true,
        joinDelaySeconds: index === 0 ? 1 : 0, regainNick: true,
      }));
      manager.connect(networks[index]!);
      await waitFor(updates, () => connections[index]?.welcomed ?? false, `registration on net${index}`);
    }
    const [delayed, plain] = connections;
    await waitFor(updates, () => manager.status()[networks[0]!.id]?.nick === 'tester', 'regained nick');
    expect(delayed!.lines).toContain('NICK tester_');
    expect(delayed!.lines.filter(line => line.includes('REGAIN'))).toEqual(['PRIVMSG NickServ :REGAIN tester']);
    // The regain goes out right after registration; the channel join waits for the configured delay.
    expect(delayed!.joinedAt).toBe(0);
    await waitFor(updates, () => delayed!.joinedAt > 0 && plain!.joinedAt > 0, 'autojoin on both networks');
    expect(delayed!.joinedAt - delayed!.welcomedAt).toBeGreaterThanOrEqual(950);
    expect(delayed!.lines.indexOf('PRIVMSG NickServ :REGAIN tester')).toBeLessThan(delayed!.lines.indexOf('JOIN #room'));

    expect(plain!.joinedAt - plain!.welcomedAt).toBeLessThan(900);
    expect(plain!.lines.some(line => line.includes('REGAIN'))).toBe(false);
    expect(manager.status()[networks[1]!.id]?.nick).toBe('tester_');
    expect(store.listBuffers().some(buffer => buffer.name.toLowerCase() === 'nickserv')).toBe(false);
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    for (const server of servers) {
      if (!server.listening) continue;
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);

test('rejoins an account-only channel after identifying and records members joining and leaving', async () => {
  const updates = new EventEmitter();
  const connections: Connection[] = [];
  let vipJoins = 0;
  const server = createServer(socket => {
    const connection: Connection = {
      socket, lines: [], pending: '', nick: '', hasUser: false, capEnded: false, welcomed: false,
    };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      connection.pending += chunk.toString();
      let end: number;
      while ((end = connection.pending.indexOf('\n')) !== -1) {
        const line = connection.pending.slice(0, end).replace(/\r$/, '');
        connection.pending = connection.pending.slice(end + 1);
        connection.lines.push(line);
        const nick = connection.nick;
        if (line.startsWith('CAP LS ')) socket.write(':mock CAP * LS :\r\n');
        else if (line.startsWith('NICK ')) connection.nick = line.slice('NICK '.length);
        else if (line.startsWith('USER ')) connection.hasUser = true;
        else if (line === 'CAP END') connection.capEnded = true;
        else if (line === 'JOIN #vip' && ++vipJoins === 1) {
          // Services identify us only after autojoin went out, as NickServ IDENTIFY in connect commands does.
          socket.write(`:mock 477 ${nick} #vip :You need to be identified to a registered account to join this channel\r\n`);
          socket.write(`:mock 900 ${nick} ${nick}!user@mock ${nick} :You are now logged in as ${nick}\r\n`);
        } else if (line === 'JOIN #vip') {
          socket.write(`:${nick}!user@mock JOIN #vip\r\n:mock 353 ${nick} = #vip :${nick} bob carol dave erin\r\n`);
          socket.write(`:mock 366 ${nick} #vip :End of /NAMES list.\r\n`);
          socket.write(':alice!user@mock JOIN #vip\r\n:bob!user@mock PART #vip :bye\r\n');
          socket.write(':carol!user@mock QUIT :Ping timeout\r\n:op!user@mock KICK #vip dave :spam\r\n');
          socket.write(':erin!user@mock NICK erin2\r\n');
        } else if (line === 'JOIN #closed') {
          socket.write(`:mock 474 ${nick} #closed :Cannot join channel (+b)\r\n`);
        }
        if (!connection.welcomed && connection.nick && connection.hasUser && connection.capEnded) {
          connection.welcomed = true;
          socket.write(`:mock 001 ${connection.nick} :Welcome\r\n`);
        }
        updates.emit('change');
      }
    });
  });
  const store = new Store(':memory:');
  const manager = new IrcManager(store, () => updates.emit('change'));
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const userId = store.createUser('tester', 'unused')!.id;
    const network = store.createNetwork(userId, {
      name: 'net', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: ['#vip'], commands: [], relayNicks: [], mentionAliases: [], displayNames: {},
      backfill: false, joinDelaySeconds: 0, regainNick: false,
    });
    manager.start();
    const vip = () => store.getOrCreateBuffer(network.id, '#vip', 'channel');
    const texts = (bufferId: number) => store.getMessages(bufferId).messages.map(message => message.text);
    await waitFor(updates, () => texts(vip().id).includes('erin is now known as erin2'), 'rejoin and member events');

    // RPL_LOGGEDIN retried the refused autojoin at once rather than leaving the channel half-joined.
    expect(connections[0]!.lines.filter(line => line === 'JOIN #vip')).toHaveLength(2);
    expect(texts(vip().id).filter(text => !['Connected', 'Joined #vip'].includes(text))).toEqual([
      'Cannot join #vip: You need to be identified to a registered account to join this channel. ' +
        'Retrying once you are identified.',
      'alice joined', 'bob left (bye)', 'carol quit (Ping timeout)', 'dave was kicked by op (spam)',
      'erin is now known as erin2',
    ]);
    expect(manager.channelState(vip().id).users.map(user => user.nick)).toEqual(['alice', 'erin2', 'tester']);
    // Member lines are status lines: they never make the channel unread.
    const memberLines = store.getMessages(vip().id).messages.filter(message => message.membership);
    expect(memberLines).toHaveLength(5);
    const unreadBefore = store.getUnread(userId)[vip().id]!.messages;
    expect(unreadBefore).toBe(store.getMessages(vip().id).messages.length - memberLines.length);

    // A refused explicit join is recorded and forgotten, so joining again sends JOIN again.
    manager.join(network.id, '#closed');
    const closed = store.getOrCreateBuffer(network.id, '#closed', 'channel');
    await waitFor(updates, () => texts(closed.id).includes('Cannot join #closed: Cannot join channel (+b)'), 'ban refusal');
    manager.join(network.id, '#closed');
    await waitFor(updates, () => connections[0]!.lines.filter(line => line === 'JOIN #closed').length === 2, 'second join');
  } finally {
    manager.stop();
    for (const connection of connections) connection.socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    store.close();
  }
}, 15_000);
