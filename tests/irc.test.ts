import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { expect, test } from 'bun:test';
import { IrcManager } from '../src/server/irc.ts';
import { Store } from '../src/server/store.ts';

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
    const network = store.createNetwork({
      name: 'mock', host: '127.0.0.1', port: address.port, tls: false,
      nick: 'tester', username: 'tester', realname: 'Test User',
      saslAccount: '', autojoin: [channel], commands: [],
      relayNicks: [], mentionAliases: [], displayNames: {},
    });
    manager.start();
    await waitFor(updates, () => connections[0]?.lines.includes(`JOIN ${channel}`) ?? false, 'initial autojoin');
    await waitFor(updates, () => store.searchMessages(messageText, { networkId: network.id }).messages
      .some(message => message.text === messageText), 'incoming message to be indexed');

    const buffer = store.getOrCreateBuffer(network.id, channel, 'channel');
    const original = store.searchMessages(messageText, { bufferId: buffer.id }).messages
      .find(message => message.text === messageText);
    expect(original).toMatchObject({ bufferId: buffer.id, networkId: network.id, nick: 'alice', kind: 'privmsg' });

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
