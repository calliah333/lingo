import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Bootstrap, ChatBuffer, ChatMessage, Network, NetworkInput, NetworkStatus, ServerEvent,
} from '../shared/contracts';
import NetworkSettings from './NetworkSettings';
import SearchPanel from './SearchPanel';

type MessagePage = { messages: ChatMessage[]; hasMore: boolean };
type View = {
  bufferId: number | null;
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string;
};
type Jump = { bufferId: number; messageId: number; serial: number };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
    throw new ApiError(typeof error === 'string' ? error : `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function messagePage(bufferId: number, before?: number, signal?: AbortSignal): Promise<MessagePage> {
  const params = new URLSearchParams({ bufferId: String(bufferId), limit: '100' });
  if (before !== undefined) params.set('before', String(before));
  return api<MessagePage>(`/api/messages?${params}`, { signal });
}
function sameChannel(left: string, right: string): boolean {
  const normalizedLeft = left.trim().replace(/^#+/, '').toLowerCase();
  const normalizedRight = right.trim().replace(/^#+/, '').toLowerCase();
  return normalizedLeft === normalizedRight;
}

function isJoined(network: Network | undefined, channel: string): boolean {
  return !!network?.autojoin.some((name) => sameChannel(name, channel));
}

function nickColor(nick: string): string {
  let hash = 0;
  for (const character of nick.toLowerCase()) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash % 360)} 58% 72%)`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

export default function App() {
  const [auth, setAuth] = useState<'checking' | 'login' | 'ready' | 'unavailable'>('checking');
  const [password, setPassword] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [networks, setNetworks] = useState<Network[]>([]);
  const [buffers, setBuffers] = useState<ChatBuffer[]>([]);
  const [statuses, setStatuses] = useState<Record<number, NetworkStatus>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<View>({ bufferId: null, messages: [], hasMore: false, loading: false, error: '' });
  const [olderPending, setOlderPending] = useState(false);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [settingsTarget, setSettingsTarget] = useState<number | 'new' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [joinNetworkId, setJoinNetworkId] = useState<number | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [jump, setJump] = useState<Jump | null>(null);
  const [reloadSerial, setReloadSerial] = useState(0);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const viewRef = useRef(view);
  viewRef.current = view;
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const generation = useRef(0);
  const bootstrapRequest = useRef(0);
  const receivedMessageIds = useRef(new Set<number>());
  const receivedMessageOrder = useRef<number[]>([]);
  const receivedMessageCursor = useRef(0);
  const jumpSerial = useRef(0);
  const scrolledJump = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prependPosition = useRef<{ height: number; top: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setAuth('login');
      setLoginError('Your session expired. Sign in again.');
    } else {
      setNotice(errorText(error));
    }
  }, []);

  const refreshBootstrap = useCallback(async (signal?: AbortSignal) => {
    const request = ++bootstrapRequest.current;
    const data = await api<Bootstrap>('/api/bootstrap', { signal });
    if (signal?.aborted || request !== bootstrapRequest.current) return data;
    setNetworks((current) => data.networks.map((network) => {
      const previous = current.find((item) => item.id === network.id);
      return previous && JSON.stringify(previous) === JSON.stringify(network) ? previous : network;
    }));
    setBuffers(data.buffers);
    setStatuses(data.statuses);
    setSelectedId((current) => {
      if (current !== null && data.buffers.some((buffer) => buffer.id === current)) return current;
      return (data.buffers.find((buffer) => buffer.kind === 'server') ?? data.buffers[0])?.id ?? null;
    });
    return data;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshBootstrap(controller.signal).then(() => setAuth('ready')).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setAuth(error instanceof ApiError && error.status === 401 ? 'login' : 'unavailable');
      if (!(error instanceof ApiError && error.status === 401)) setLoginError(errorText(error));
    });
    return () => controller.abort();
  }, [refreshBootstrap]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || loginPending) return;
    setLoginPending(true);
    setLoginError('');
    try {
      await api<unknown>('/api/login', json('POST', { password }));
      await refreshBootstrap();
      setPassword('');
      setAuth('ready');
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      setLoginPending(false);
    }
  }

  async function logout() {
    try {
      await api<unknown>('/api/logout', { method: 'POST' });
      setAuth('login');
      setNetworks([]);
      setBuffers([]);
      setSelectedId(null);
      setView({ bufferId: null, messages: [], hasMore: false, loading: false, error: '' });
      setSettingsTarget(null);
      setSearchOpen(false);
      setNotice('');
    } catch (error) {
      fail(error);
    }
  }
  useEffect(() => {
    if (auth !== 'ready') return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        setSettingsTarget(null);
        return;
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setSettingsTarget(null);
        setSidebarOpen(false);
        setJoinNetworkId(null);
        return;
      }
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === '/' && !typing && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (inputRef.current) {
          event.preventDefault();
          inputRef.current.focus();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [auth]);


  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    const controller = new AbortController();

    async function catchUp(bufferId: number) {
      const snapshot = viewRef.current;
      if (snapshot.bufferId !== bufferId || snapshot.loading || jumpRef.current) return;
      const currentGeneration = generation.current;
      const anchor = snapshot.messages.at(-1)?.id ?? 0;
      let before: number | undefined;
      let first = true;
      while (active && !controller.signal.aborted) {
        const page = await messagePage(bufferId, before, controller.signal);
        if (!active || selectedRef.current !== bufferId || generation.current !== currentGeneration || jumpRef.current) return;
        setView((current) => current.bufferId !== bufferId ? current : {
          ...current,
          messages: mergeMessages(current.messages, page.messages),
          hasMore: anchor === 0 && first ? page.hasMore : current.hasMore,
        });
        first = false;
        const earliest = page.messages[0]?.id;
        if (!page.hasMore || earliest === undefined || anchor === 0 || earliest <= anchor) break;
        before = earliest;
      }
    }

    function receive(event: ServerEvent) {
      switch (event.type) {
        case 'message':
          if (receivedMessageIds.current.has(event.message.id)) break;
          const order = receivedMessageOrder.current;
          const slot = receivedMessageCursor.current % 2000;
          const expired = order[slot];
          if (expired !== undefined) receivedMessageIds.current.delete(expired);
          order[slot] = event.message.id;
          receivedMessageCursor.current++;
          if (!jumpRef.current && selectedRef.current === event.message.bufferId) {
            setView((current) => current.bufferId === event.message.bufferId
              ? { ...current, messages: mergeMessages(current.messages, [event.message]) }
              : current);
          } else {
            setUnread((current) => ({ ...current, [event.message.bufferId]: (current[event.message.bufferId] ?? 0) + 1 }));
          }
          if (!buffersRef.current.some((buffer) => buffer.id === event.message.bufferId)) {
            void refreshBootstrap(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          }
          break;
        case 'buffer':
          setBuffers((current) => current.some((buffer) => buffer.id === event.buffer.id)
            ? current.map((buffer) => buffer.id === event.buffer.id ? event.buffer : buffer)
            : [...current, event.buffer]);
          break;
        case 'buffer_removed': {
          const remaining = buffersRef.current.filter((buffer) => buffer.id !== event.bufferId);
          setBuffers(remaining);
          setSelectedId((selected) => selected === event.bufferId ? (remaining[0]?.id ?? null) : selected);
          setUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
          break;
        }
        case 'network':
          setStatuses((current) => ({ ...current, [event.networkId]: event.status }));
          // Network metadata is not included in this event; a second tab may have changed it.
          void refreshBootstrap(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          break;
        case 'network_removed': {
          const remaining = buffersRef.current.filter((buffer) => buffer.networkId !== event.networkId);
          setNetworks((current) => current.filter((network) => network.id !== event.networkId));
          setBuffers(remaining);
          setSelectedId((selected) => selected !== null && !remaining.some((buffer) => buffer.id === selected)
            ? (remaining[0]?.id ?? null) : selected);
          setStatuses((current) => { const next = { ...current }; delete next[event.networkId]; return next; });
          break;
        }
      }
    }

    function connect() {
      if (!active) return;
      setConnection('connecting');
      const url = new URL('/api/events', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (!active) return;
        attempt = 0;
        setConnection('live');
        void refreshBootstrap(controller.signal).then(() => {
          const bufferId = selectedRef.current;
          if (bufferId !== null) return catchUp(bufferId);
        }).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
      };
      socket.onmessage = (message) => {
        try { receive(JSON.parse(message.data as string) as ServerEvent); } catch { /* Ignore malformed events. */ }
      };
      socket.onclose = () => {
        if (!active) return;
        setConnection('offline');
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
        retryTimer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [auth, fail, refreshBootstrap]);

  useEffect(() => {
    if (auth !== 'ready') return;
    const bufferId = selectedId;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    setOlderPending(false);
    setUnread((current) => {
      if (bufferId === null || !current[bufferId]) return current;
      const next = { ...current }; delete next[bufferId]; return next;
    });
    atBottom.current = true;
    prependPosition.current = null;
    setView({ bufferId, messages: [], hasMore: false, loading: bufferId !== null, error: '' });
    if (bufferId !== null) {
      const before = jump?.bufferId === bufferId ? jump.messageId + 1 : undefined;
      void messagePage(bufferId, before, controller.signal).then((page) => {
        if (controller.signal.aborted || generation.current !== currentGeneration) return;
        setView((current) => current.bufferId !== bufferId ? current : {
          ...current, messages: mergeMessages(current.messages, page.messages), hasMore: page.hasMore, loading: false,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || generation.current !== currentGeneration) return;
        if (error instanceof ApiError && error.status === 401) fail(error);
        setView((current) => current.bufferId !== bufferId ? current : { ...current, loading: false, error: errorText(error) });
      });
    }
    return () => controller.abort();
  }, [auth, selectedId, jump, reloadSerial, fail]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || view.bufferId !== selectedId) return;
    if (prependPosition.current) {
      log.scrollTop = prependPosition.current.top + log.scrollHeight - prependPosition.current.height;
      atBottom.current = false;
      prependPosition.current = null;
    } else if (jump && !view.loading && jump.bufferId === selectedId && scrolledJump.current !== jump.serial) {
      const target = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.dataset.messageId === String(jump.messageId));
      if (target) {
        target.scrollIntoView({ block: 'center' });
        scrolledJump.current = jump.serial;
      }
    } else if (atBottom.current && !jump) {
      log.scrollTop = log.scrollHeight;
    }
  }, [view, selectedId, jump]);

  function selectBuffer(id: number) {
    setJump(null);
    setSelectedId(id);
    setSearchOpen(false);
    setSettingsTarget(null);
    setSidebarOpen(false);
    setNotice('');
    setUnread((current) => { const next = { ...current }; delete next[id]; return next; });
    inputRef.current?.focus();
  }

  async function loadOlder() {
    if (view.bufferId !== selectedId || selectedId === null || view.loading || olderPending || !view.hasMore) return;
    const oldest = view.messages[0]?.id;
    if (oldest === undefined) return;
    const currentGeneration = generation.current;
    setOlderPending(true);
    setNotice('');
    try {
      const page = await messagePage(selectedId, oldest);
      if (generation.current !== currentGeneration || selectedRef.current !== selectedId) return;
      const log = logRef.current;
      atBottom.current = false;
      if (log) prependPosition.current = { height: log.scrollHeight, top: log.scrollTop };
      setView((current) => current.bufferId !== selectedId ? current : {
        ...current, messages: mergeMessages(current.messages, page.messages), hasMore: page.hasMore,
      });
    } catch (error) {
      fail(error);
    } finally {
      setOlderPending(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedId === null || sending || !composer.trim()) return;
    const text = composer;
    setSending(true);
    setNotice('');
    try {
      await api<{ ok: true }>('/api/send', json('POST', { bufferId: selectedId, text }));
      setComposer((current) => current === text ? '' : current);
      inputRef.current?.focus();
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
    }
  }

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joinNetworkId === null || joining || !joinName.trim()) return;
    setJoining(true);
    setNotice('');
    try {
      const buffer = await api<ChatBuffer>('/api/buffers', json('POST', { networkId: joinNetworkId, name: joinName.trim() }));
      setBuffers((current) => current.some((item) => item.id === buffer.id) ? current : [...current, buffer]);
      setJoinName('');
      setJoinNetworkId(null);
      selectBuffer(buffer.id);
      await refreshBootstrap();
    } catch (error) {
      fail(error);
    } finally {
      setJoining(false);
    }
  }

  async function rejoin(buffer: ChatBuffer) {
    if (joining) return;
    setJoining(true);
    setNotice('');
    try {
      const joined = await api<ChatBuffer>('/api/buffers', json('POST', { networkId: buffer.networkId, name: buffer.name }));
      setBuffers((current) => current.some((item) => item.id === joined.id)
        ? current.map((item) => item.id === joined.id ? joined : item)
        : [...current, joined]);
      await refreshBootstrap();
      selectBuffer(joined.id);
    } catch (error) {
      fail(error);
    } finally {
      setJoining(false);
    }
  }

  async function part(buffer: ChatBuffer) {
    if (!window.confirm(`Leave ${buffer.name}?`)) return;
    setNotice('');
    try {
      await api<unknown>(`/api/buffers/${buffer.id}`, { method: 'DELETE' });
      await refreshBootstrap();
      setNotice(`Left ${buffer.name}. Its message history is retained.`);
    } catch (error) {
      fail(error);
    }
  }

  async function saveNetwork(input: NetworkInput, id?: number) {
    const network = await api<Network>(id === undefined ? '/api/networks' : `/api/networks/${id}`,
      json(id === undefined ? 'POST' : 'PATCH', input));
    const data = await refreshBootstrap();
    if (id === undefined) {
      const server = data.buffers.find((buffer) => buffer.networkId === network.id && buffer.kind === 'server');
      if (server) selectBuffer(server.id);
    }
    setSettingsTarget(null);
  }

  async function deleteNetwork(id: number) {
    await api<unknown>(`/api/networks/${id}`, { method: 'DELETE' });
    await refreshBootstrap();
    setSettingsTarget(null);
  }

  function jumpTo(message: ChatMessage) {
    setJump({ bufferId: message.bufferId, messageId: message.id, serial: ++jumpSerial.current });
    setSelectedId(message.bufferId);
    setSearchOpen(false);
    setSidebarOpen(false);
    setSettingsTarget(null);
    setNotice('');
  }

  if (auth !== 'ready') {
    return <main className="auth-screen">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <h1>lingo<span className="brand-cursor">_</span></h1>
        <p className="muted">A quieter place for IRC.</p>
        {auth === 'checking' && <p className="auth-status" role="status">Opening session…</p>}
        {auth === 'unavailable' && <>
          <p className="error-text" role="alert">{loginError || 'Could not reach the server.'}</p>
          <button className="button button-primary" type="button" onClick={() => {
            setAuth('checking');
            void refreshBootstrap().then(() => setAuth('ready')).catch((error: unknown) => {
              setAuth(error instanceof ApiError && error.status === 401 ? 'login' : 'unavailable');
              setLoginError(errorText(error));
            });
          }}>Try again</button>
        </>}
        {auth === 'login' && <form className="auth-form" onSubmit={login}>
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" autoComplete="current-password" autoFocus required value={password}
            onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" />
          {loginError && <p className="error-text" role="alert">{loginError}</p>}
          <button className="button button-primary" type="submit" disabled={loginPending || !password}>
            {loginPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>}
      </div>
    </main>;
  }

  const selected = buffers.find((buffer) => buffer.id === selectedId) ?? null;
  const activeNetwork = networks.find((network) => network.id === selected?.networkId);
  const selectedJoined = selected?.kind !== 'channel' || isJoined(activeNetwork, selected.name);
  const settingsNetwork = typeof settingsTarget === 'number' ? networks.find((network) => network.id === settingsTarget) ?? null : null;
  const showingView = view.bufferId === selectedId;
  const messages = showingView ? view.messages : [];

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-menu" type="button" aria-label="Toggle networks" aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}>☰</button>
        <span className="brand">lingo<span className="brand-cursor">_</span></span>
        <span className={`transport transport-${connection}`} role="status" aria-label={`Live updates ${connection}`}>
          <span className="status-dot" />{connection === 'live' ? 'live' : connection === 'offline' ? 'reconnecting' : 'connecting'}
        </span>
      </div>
      <div className="topbar-actions">
        <button className="button button-quiet" type="button" onClick={() => { setSearchOpen(true); setSettingsTarget(null); }}>Search <kbd>⌕</kbd></button>
        <button className="button button-quiet" type="button" onClick={() => { setSettingsTarget('new'); setSearchOpen(false); }}>Add network</button>
        <button className="button button-quiet logout-button" type="button" onClick={() => void logout()}>Sign out</button>
      </div>
    </header>
    <div className="workspace">
      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close networks" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`} aria-label="Networks and buffers">
        <div className="sidebar-heading"><span>NETWORKS</span><button type="button" className="icon-button" aria-label="Add network" title="Add network"
          onClick={() => { setSettingsTarget('new'); setSearchOpen(false); setSidebarOpen(false); }}>+</button></div>
        {networks.length === 0 && <div className="sidebar-empty">No networks yet.<button className="text-button" type="button"
          onClick={() => { setSettingsTarget('new'); setSidebarOpen(false); }}>Set one up →</button></div>}
        {networks.map((network) => {
          const status = statuses[network.id];
          const state = status?.state ?? 'disconnected';
          const networkBuffers = buffers.filter((buffer) => buffer.networkId === network.id)
            .sort((a, b) => (a.kind === 'server' ? -1 : b.kind === 'server' ? 1 : a.name.localeCompare(b.name)));
          return <section className="network-group" key={network.id} aria-label={`${network.name} network`}>
            <div className="network-heading">
              <span className={`status-dot status-${state}`} title={status?.error || state} aria-label={state} />
              <span className="network-name" title={network.name}>{network.name}</span>
              <button className="icon-button network-action" type="button" aria-label={`Join channel on ${network.name}`} title="Join channel"
                onClick={() => { setJoinNetworkId(joinNetworkId === network.id ? null : network.id); setJoinName(''); }}>+</button>
              <button className="icon-button network-action" type="button" aria-label={`Edit ${network.name}`} title="Network settings"
                onClick={() => { setSettingsTarget(network.id); setSearchOpen(false); setSidebarOpen(false); }}>⚙</button>
            </div>
            {status?.error && <span className="network-error" title={status.error}>{status.error}</span>}
            {joinNetworkId === network.id && <form className="join-form" onSubmit={join}>
              <label className="sr-only" htmlFor={`join-${network.id}`}>Channel to join on {network.name}</label>
              <input id={`join-${network.id}`} autoFocus value={joinName} onChange={(event) => setJoinName(event.target.value)}
                placeholder="#channel" autoComplete="off" disabled={joining} />
              <button className="button button-primary" type="submit" disabled={joining || !joinName.trim()}>{joining ? '…' : 'Join'}</button>
            </form>}
            <nav className="buffer-list" aria-label={`${network.name} buffers`}>
              {networkBuffers.map((buffer) => {
                const parted = buffer.kind === 'channel' && !isJoined(network, buffer.name);
                return <div className="buffer-entry" key={buffer.id}>
                  <button type="button" className={`buffer-item${selectedId === buffer.id ? ' buffer-active' : ''}`}
                    aria-current={selectedId === buffer.id ? 'page' : undefined} onClick={() => selectBuffer(buffer.id)}>
                    <span className="buffer-prefix">{buffer.kind === 'channel' ? '#' : buffer.kind === 'query' ? '@' : '⌁'}</span>
                    <span className="buffer-name">{buffer.kind === 'channel' ? buffer.name.replace(/^#/, '') : buffer.name}</span>
                    {parted && <span className="buffer-parted">left</span>}
                    {!!unread[buffer.id] && <span className="unread-badge" aria-label={`${unread[buffer.id]} unread messages`}>{unread[buffer.id]}</span>}
                  </button>
                  {parted && <button type="button" className="buffer-rejoin" disabled={joining}
                    aria-label={`Rejoin ${buffer.name} on ${network.name}`} onClick={() => void rejoin(buffer)}>↻</button>}
                </div>;
              })}
            </nav>
          </section>;
        })}
        <div className="sidebar-footer">IRC, uninterrupted.</div>
      </aside>
      <main className="main-pane">
        {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" type="button" aria-label="Dismiss error" onClick={() => setNotice('')}>×</button></div>}
        {settingsTarget !== null ? <div className="panel-scroll"><NetworkSettings key={settingsTarget} network={settingsNetwork}
          onSave={saveNetwork} onDelete={deleteNetwork} onClose={() => setSettingsTarget(null)} /></div>
        : searchOpen ? <SearchPanel networks={networks} buffers={buffers} onClose={() => setSearchOpen(false)} onJump={jumpTo} />
        : selected ? <>
          <header className="conversation-header">
            <div className="conversation-title">
              <span className="conversation-overline">{activeNetwork?.name ?? 'Network'} <span className="divider">/</span> {selected.kind}</span>
              <h1>{selected.name}</h1>
            </div>
            <div className="conversation-actions">
              {jump && jump.bufferId === selected.id && <button className="button button-quiet" type="button" onClick={() => setJump(null)}>Back to latest</button>}
              {selected.kind === 'channel' && !selectedJoined
                ? <button className="button button-primary" type="button" onClick={() => void rejoin(selected)} disabled={joining}>
                  {joining ? 'Joining…' : 'Rejoin'}
                </button>
                : selected.kind === 'channel' && <button className="button button-quiet" type="button" onClick={() => void part(selected)}>Leave</button>}
            </div>
          </header>
          <div className="conversation-meta">
            <span className={`status-dot status-${statuses[selected.networkId]?.state ?? 'disconnected'}`} />
            {statuses[selected.networkId]?.state ?? 'disconnected'}
            {statuses[selected.networkId]?.nick && <span>as {statuses[selected.networkId].nick}</span>}
            {jump && jump.bufferId === selected.id && <span className="history-indicator">Viewing search result</span>}
            {selected.kind === 'channel' && !selectedJoined && <span className="buffer-state">Parted — history is retained</span>}
          </div>
          <div className="message-scroll" ref={logRef} role="log" aria-label={`Messages in ${selected.name}`} aria-live="off"
            onScroll={(event) => {
              const element = event.currentTarget;
              atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}>
            <div className="history-controls">
              {showingView && view.hasMore && <button className="button button-quiet" type="button" onClick={() => void loadOlder()} disabled={olderPending}>
                {olderPending ? 'Loading…' : 'Load older messages'}
              </button>}
              {showingView && view.error && <div className="error-text" role="alert">{view.error} <button className="text-button" type="button" onClick={() => setReloadSerial((current) => current + 1)}>Retry</button></div>}
              {(!showingView || view.loading) && <span className="muted" role="status">Loading messages…</span>}
              {showingView && !view.loading && !view.error && !messages.length && <span className="muted">No messages yet. This buffer is ready when you are.</span>}
            </div>
            <ol className="message-list">
              {messages.map((message) => <li className={`message-row message-${message.kind}${jump?.messageId === message.id ? ' message-highlight' : ''}`}
                key={message.id} data-message-id={message.id}>
                <time className="message-time" dateTime={new Date(message.time).toISOString()} title={new Date(message.time).toLocaleString()}>{clock.format(message.time)}</time>
                <span className="message-nick" style={message.nick ? { color: nickColor(message.nick) } : undefined}>{message.nick ?? (message.kind === 'system' ? 'server' : 'notice')}</span>
                <span className="message-text">{message.text}</span>
              </li>)}
            </ol>
          </div>
          <form className="composer" onSubmit={send}>
            <span className="composer-prompt" aria-hidden="true">›</span>
            <label className="sr-only" htmlFor="message-input">Message to {selected.name}</label>
            <input id="message-input" ref={inputRef} type="text" autoComplete="off" value={composer}
              onChange={(event) => setComposer(event.target.value)} placeholder={selected.kind === 'server' ? 'Type a command…' : `Message ${selected.name} or /command…`} disabled={!selectedJoined} />
            <button className="button button-primary send-button" type="submit" disabled={sending || !composer.trim()}>{sending ? 'Sending…' : 'Send ↵'}</button>
          </form>
        </> : <div className="welcome">
          <span className="welcome-glyph" aria-hidden="true">&gt;_</span>
          <h1>{networks.length ? 'Select a buffer' : 'Connect to IRC'}</h1>
          <p>{networks.length ? 'Choose a network or join a channel to start reading.' : 'Add a network to keep your channels and history in one place.'}</p>
          {!networks.length && <button className="button button-primary" type="button" onClick={() => setSettingsTarget('new')}>Add your first network</button>}
        </div>}
      </main>
    </div>
  </div>;
}
