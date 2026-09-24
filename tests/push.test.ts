import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { expect, test } from 'bun:test';
import type { ChatMessage, PushNotification } from '../src/shared/contracts.ts';
import { createApp } from '../src/server/app.ts';
import { IrcManager } from '../src/server/irc.ts';
import { PushNotifier, type PushSender } from '../src/server/push.ts';
import { Store } from '../src/server/store.ts';

const HOST = 'lingo.test';
const PASSWORD = 'correct horse battery staple';

type Sent = { endpoint: string; notification: PushNotification };

/** Records deliveries; endpoints listed in `statuses` answer with that HTTP status instead of 201. */
function stubSender(updates: EventEmitter, statuses = new Map<string, number>()) {
  const sent: Sent[] = [];
  const send: PushSender = async (target, payload) => {
    sent.push({ endpoint: target.endpoint, notification: JSON.parse(payload) as PushNotification });
    updates.emit('change');
    return statuses.get(target.endpoint) ?? 201;
  };
  return { sent, send };
}

function device(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.test/${name}`,
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

function waitFor(updates: EventEmitter, condition: () => boolean, description: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const check = () => {
    if (!condition()) return;
    clearTimeout(timeout);
    updates.off('change', check);
    resolve();
  };
  const timeout = setTimeout(() => {
    updates.off('change', check);
    reject(new Error(`Timed out waiting for ${description}`));
  }, 5_000);
  updates.on('change', check);
  check();
  return promise;
}

test('push subscription routes validate devices, cap them per user, and drop gone endpoints', async () => {
  const updates = new EventEmitter();
  const store = new Store(':memory:');
  const statuses = new Map<string, number>();
  const { sent, send } = stubSender(updates, statuses);
  const push = new PushNotifier(store, 'public-key', send);
  const manager = new IrcManager(store, () => {}, push);
  const { app } = createApp(store, manager, { setupToken: 'token', push });
  const call = (path: string, options: { method?: string; cookie?: string; body?: unknown } = {}) =>
    Promise.resolve(app.request(`http://${HOST}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }));
  const cookieOf = (response: Response) => {
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  try {
    const admin = cookieOf(await call('/api/setup', {
      method: 'POST', body: { username: 'root', password: PASSWORD, token: 'token' },
    }));
    expect((await call('/api/users', { method: 'POST', cookie: admin, body: { username: 'bob', password: PASSWORD } })).status)
      .toBe(201);
    const bob = cookieOf(await call('/api/login', { method: 'POST', body: { username: 'bob', password: PASSWORD } }));

    expect(await (await call('/api/push/key', { cookie: admin })).json()).toEqual({ publicKey: 'public-key' });
    expect((await call('/api/push/key')).status).toBe(401);
    for (const endpoint of ['http://push.example.test/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x']) {
      expect((await call('/api/push/subscriptions', {
        method: 'POST', cookie: admin, body: { ...device('x'), endpoint },
      })).status).toBe(400);
    }
    expect((await call('/api/push/subscriptions', {
      method: 'POST', cookie: admin, body: { ...device('x'), keys: { ...device('x').keys, auth: 'c2hvcnQ' } },
    })).status).toBe(400);

    for (let index = 0; index < 10; index++) {
      expect((await call('/api/push/subscriptions', { method: 'POST', cookie: admin, body: device(`admin-${index}`) })).status)
        .toBe(201);
    }
    expect((await call('/api/push/subscriptions', { method: 'POST', cookie: admin, body: device('admin-10') })).status)
      .toBe(409);
    // Re-registering a known device refreshes it instead of counting as another one.
    expect((await call('/api/push/subscriptions', { method: 'POST', cookie: admin, body: device('admin-0') })).status)
      .toBe(201);
    expect((await call('/api/push/subscriptions', { method: 'POST', cookie: bob, body: device('bob') })).status).toBe(201);

    // Another user's DELETE cannot remove a device it does not own.
    expect((await call('/api/push/subscriptions', {
      method: 'DELETE', cookie: bob, body: { endpoint: device('admin-9').endpoint },
    })).status).toBe(200);
    expect(store.listPushSubscriptions(1)).toHaveLength(10);
    expect((await call('/api/push/subscriptions', {
      method: 'DELETE', cookie: admin, body: { endpoint: device('admin-9').endpoint },
    })).status).toBe(200);
    expect(store.listPushSubscriptions(1)).toHaveLength(9);

    statuses.set(device('admin-1').endpoint, 410);
    statuses.set(device('admin-2').endpoint, 404);
    statuses.set(device('admin-3').endpoint, 500);
    const tested = await call('/api/push/test', { method: 'POST', cookie: admin });
    expect(await tested.json()).toEqual({ delivered: 6 });
    expect(sent.map(item => item.endpoint)).not.toContain(device('bob').endpoint);
    expect(sent[0]!.notification).toEqual({ bufferId: null, title: 'Lingo', body: 'Test notification' });
    expect(store.listPushSubscriptions(1).map(item => item.endpoint)).not.toContain(device('admin-1').endpoint);
    expect(store.listPushSubscriptions(1).map(item => item.endpoint)).not.toContain(device('admin-2').endpoint);
    expect(store.listPushSubscriptions(1).map(item => item.endpoint)).toContain(device('admin-3').endpoint);

    // Signing out removes the devices registered by that session.
    expect((await call('/api/logout', { method: 'POST', cookie: bob })).status).toBe(200);
    const bobId = store.listUsers().find(user => user.username === 'bob')!.id;
    expect(store.listPushSubscriptions(bobId)).toEqual([]);
  } finally {
    manager.stop();
    store.close();
  }
});

test('mentions and private messages push only to an absent, unmuted owner, throttled per buffer', async () => {
  const updates = new EventEmitter();
  const sockets: Socket[] = [];
  const peers = new Map<string, Socket>();
  const server = createServer(socket => {
    sockets.push(socket);
    let pending = '';
    let nick = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.startsWith('CAP LS')) socket.write(':mock CAP * LS :\r\n');
        else if (line.startsWith('NICK ')) peers.set(nick = line.slice(5), socket);
        else if (line.startsWith('USER ')) socket.write(`:mock 001 ${nick} :Welcome\r\n`);
        else if (line.startsWith('JOIN ')) socket.write(`:${nick}!u@mock JOIN :${line.slice(5)}\r\n`);
      }
    });
  });
  const store = new Store(':memory:');
  let time = 1_000_000;
  const { sent, send } = stubSender(updates);
  const push = new PushNotifier(store, 'public-key', send, () => time);
  const messages: ChatMessage[] = [];
  const manager = new IrcManager(store, (event) => {
    if (event.type === 'message') messages.push(event.message);
    updates.emit('change');
  }, push);
  try {
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const input = {
      host: '127.0.0.1', port: address.port, tls: false, username: 'u', realname: 'U', saslAccount: '',
      autojoin: ['#room'], commands: [], relayNicks: [], mentionAliases: [], displayNames: {}, backfill: true, joinDelaySeconds: 0, regainNick: false,
    };
    const alice = store.createUser('alice', 'scrypt:alice')!;
    const bob = store.createUser('bob', 'scrypt:bob')!;
    store.createSession('alice-phone', alice.id, time + 86_400_000);
    store.createSession('bob-phone', bob.id, time + 86_400_000);
    store.savePushSubscription(alice.id, 'alice-phone',
      { endpoint: 'https://push.example.test/alice', p256dh: 'p', auth: 'a' }, 10, time);
    store.savePushSubscription(bob.id, 'bob-phone',
      { endpoint: 'https://push.example.test/bob', p256dh: 'p', auth: 'a' }, 10, time);
    const aliceNetwork = store.createNetwork(alice.id, { ...input, name: 'A', nick: 'alice' });
    store.createNetwork(bob.id, { ...input, name: 'B', nick: 'bob' });
    manager.start();
    await waitFor(updates, () => peers.size === 2 && Object.values(manager.status())
      .every(status => status.state === 'connected'), 'both connections');
    const aliceSocket = peers.get('alice')!;
    const bobSocket = peers.get('bob')!;
    let seen = 0;
    const deliver = async (socket: Socket, line: string) => {
      const expected = ++seen;
      socket.write(`${line}\r\n`);
      await waitFor(updates, () => messages.filter(message => message.kind !== 'system').length >= expected,
        `message ${expected}`);
      // Pushes are sent asynchronously after the message is stored.
      await Promise.resolve();
    };

    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :just chatting');
    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :alice: ping');
    await waitFor(updates, () => sent.length === 1, 'mention push');
    const room = store.getOrCreateBuffer(aliceNetwork.id, '#room', 'channel');
    expect(sent).toEqual([{ endpoint: 'https://push.example.test/alice',
      notification: { bufferId: room.id, title: 'carol · #room', body: 'New mention' } }]);

    // A second mention in the same buffer within 30 s is throttled; later ones push again.
    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :alice: again');
    time += 30_000;
    store.patchSettings(alice.id, { pushIncludesText: true });
    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :alice: later');
    await waitFor(updates, () => sent.length === 2, 'post-throttle push');
    expect(sent[1]!.notification.body).toBe('alice: later');

    // An open browser suppresses pushes; so do mutes. Private messages push on their own.
    manager.setBrowserPresence(new Set([alice.id]));
    time += 30_000;
    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :alice: while present');
    manager.setBrowserPresence(new Set());
    store.patchSettings(alice.id, { mutedBuffers: [room.id] });
    await deliver(aliceSocket, ':carol!u@mock PRIVMSG #room :alice: while muted');
    await deliver(aliceSocket, ':dave!u@mock PRIVMSG alice :hello there');
    await waitFor(updates, () => sent.length === 3, 'private message push');
    const query = store.getOrCreateBuffer(aliceNetwork.id, 'dave', 'query');
    expect(sent[2]).toEqual({ endpoint: 'https://push.example.test/alice',
      notification: { bufferId: query.id, title: 'dave · dave', body: 'hello there' } });

    // Bob's mention goes to Bob's device only.
    await deliver(bobSocket, ':carol!u@mock PRIVMSG #room :bob: ping');
    await waitFor(updates, () => sent.length === 4, 'other user push');
    expect(sent[3]!.endpoint).toBe('https://push.example.test/bob');
    expect(sent.filter(item => item.endpoint.endsWith('/alice'))).toHaveLength(3);
  } finally {
    manager.stop();
    server.close();
    for (const socket of sockets) socket.destroy();
    store.close();
  }
}, 15_000);
