import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type {
  Bootstrap, ChannelListStatus, ChannelState, ChatBuffer, ChatMessage, Network, NetworkInput, NetworkStatus, ServerEvent,
} from '../shared/contracts';
import { displayIdentity, mentionsAny } from '../shared/identity';
import { api, ApiError, errorText, json } from './api';
import ChannelListPanel from './ChannelListPanel';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { BanListDialog, IgnoreListDialog, WhoisDialog } from './Dialogs';
import MentionComposer from './MentionComposer';
import GlobalSettings from './GlobalSettings';
import NetworkSettings from './NetworkSettings';
import { applyAppearance, loadPreferences, savePreferences, type AppPreferences } from './preferences';
import SearchPanel from './SearchPanel';
import Transcript from './Transcript';
import ThemePicker from './ThemePicker';
import UserList from './UserList';

type MessagePage = { messages: ChatMessage[]; hasMore: boolean };
type ChannelDetails = { bufferId: number; state: ChannelState | null; loading: boolean; error: string };
type View = {
  bufferId: number | null;
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string;
};
type Jump = { bufferId: number; messageId: number; serial: number };
type MenuSubject =
  | { kind: 'network'; networkId: number }
  | { kind: 'buffer'; bufferId: number }
  | { kind: 'user'; networkId: number; nick: string };
type MenuTarget = MenuSubject & { x: number; y: number };
type DialogTarget =
  | { kind: 'whois'; networkId: number; nick: string }
  | { kind: 'bans'; bufferId: number }
  | { kind: 'ignores'; networkId: number };
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return current;
  if (!current.length) return incoming;
  if (incoming[0].id > current.at(-1)!.id) return [...current, ...incoming];
  if (incoming.at(-1)!.id < current[0].id) return [...incoming, ...current];
  const merged: ChatMessage[] = [];
  let left = 0;
  let right = 0;
  while (left < current.length && right < incoming.length) {
    const currentId = current[left].id;
    const incomingId = incoming[right].id;
    if (currentId < incomingId) merged.push(current[left++]);
    else if (currentId > incomingId) merged.push(incoming[right++]);
    else {
      merged.push(incoming[right++]);
      left++;
    }
  }
  while (left < current.length) merged.push(current[left++]);
  while (right < incoming.length) merged.push(incoming[right++]);
  return merged;
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


function savedIds(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

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
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [settingsTarget, setSettingsTarget] = useState<number | 'new' | null>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [joinNetworkId, setJoinNetworkId] = useState<number | null>(null);
  const [collapsedNetworks, setCollapsedNetworks] = useState<number[]>(() => savedIds('lingo-collapsed-networks'));
  const [hiddenBuffers, setHiddenBuffers] = useState<number[]>(() => savedIds('lingo-hidden-buffers'));
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [mutedBuffers, setMutedBuffers] = useState<number[]>(() => savedIds('lingo-muted-buffers'));
  const [mutedNetworks, setMutedNetworks] = useState<number[]>(() => savedIds('lingo-muted-networks'));
  const [ignores, setIgnores] = useState<Record<number, string[]>>({});
  const [channelListTabs, setChannelListTabs] = useState<number[]>(() => savedIds('lingo-channel-lists'));
  const [channelListView, setChannelListView] = useState<number | null>(null);
  const [channelLists, setChannelLists] = useState<Record<number, ChannelListStatus>>({});
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [channelDetails, setChannelDetails] = useState<ChannelDetails | null>(null);
  const [usersPanelOpen, setUsersPanelOpen] = useState(false);
  const [topicEditing, setTopicEditing] = useState(false);
  const [topicDraft, setTopicDraft] = useState('');
  const [topicSaving, setTopicSaving] = useState(false);
  const [topicError, setTopicError] = useState('');
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [renameTarget, setRenameTarget] = useState<{ networkId: number; nick: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [mentionUnread, setMentionUnread] = useState<Record<number, number>>({});
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
  const networksRef = useRef(networks);
  networksRef.current = networks;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const hiddenBuffersRef = useRef(hiddenBuffers);
  hiddenBuffersRef.current = hiddenBuffers;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const mutedRef = useRef({ buffers: mutedBuffers, networks: mutedNetworks });
  mutedRef.current = { buffers: mutedBuffers, networks: mutedNetworks };
  const pendingTopicEdit = useRef<number | null>(null);
  const overlayOpen = useRef(false);
  overlayOpen.current = menu !== null || dialog !== null;
  const generation = useRef(0);
  const bootstrapRequest = useRef(0);
  const receivedMessageIds = useRef(new Set<number>());
  const receivedMessageOrder = useRef<number[]>([]);
  const receivedMessageCursor = useRef(0);
  const jumpSerial = useRef(0);
  const messageQueue = useRef<ChatMessage[]>([]);
  const messageFrame = useRef<number | null>(null);
  const channelStateVersion = useRef(0);
  const olderRequest = useRef<{ bufferId: number; controller: AbortController } | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  const activeBuffer = buffers.find((buffer) => buffer.id === selectedId);
  const selectedChannelId = activeBuffer?.kind === 'channel' ? activeBuffer.id : null;
  const channelJoined = activeBuffer?.kind === 'channel'
    && isJoined(networks.find((network) => network.id === activeBuffer.networkId), activeBuffer.name);
  const channelConnected = activeBuffer?.kind === 'channel'
    && statuses[activeBuffer.networkId]?.state === 'connected';
  const sessionExpired = useCallback(() => {
    setAuth('login');
    setLoginError('Your session expired. Sign in again.');
    setDialog(null);
    setMenu(null);
  }, []);
  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) sessionExpired();
    else setNotice(errorText(error));
  }, [sessionExpired]);

  function openMenu(event: ReactMouseEvent<HTMLElement>, subject: MenuSubject) {
    event.preventDefault();
    // Keyboard-invoked context menus report no pointer position; anchor to the element.
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX !== 0 || event.clientY !== 0;
    setMenu({ ...subject, x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom });
  }

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
    setIgnores(data.ignores);
    setSelectedId((current) => {
      if (current !== null && data.buffers.some((buffer) => buffer.id === current && !hiddenBuffersRef.current.includes(buffer.id))) return current;
      return (data.buffers.find((buffer) => buffer.kind === 'server')
        ?? data.buffers.find((buffer) => !hiddenBuffersRef.current.includes(buffer.id)))?.id ?? null;
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
  useEffect(() => {
    applyAppearance(preferences);
    savePreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    try {
      localStorage.setItem('lingo-collapsed-networks', JSON.stringify(collapsedNetworks));
      localStorage.setItem('lingo-hidden-buffers', JSON.stringify(hiddenBuffers));
      localStorage.setItem('lingo-muted-buffers', JSON.stringify(mutedBuffers));
      localStorage.setItem('lingo-muted-networks', JSON.stringify(mutedNetworks));
      localStorage.setItem('lingo-channel-lists', JSON.stringify(channelListTabs));
    } catch { /* Storage may be disabled. */ }
  }, [collapsedNetworks, hiddenBuffers, mutedBuffers, mutedNetworks, channelListTabs]);

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
      setGlobalSettingsOpen(false);
      setSearchOpen(false);
      setNotice('');
    } catch (error) {
      fail(error);
    }
  }

  async function enableNotifications() {
    if (typeof Notification === 'undefined') throw new Error('Browser notifications are not supported here.');
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Allow notifications in your browser to enable this setting.');
    setPreferences((current) => ({ ...current, browserNotifications: true }));
  }

  function changeSound(enabled: boolean) {
    if (enabled) {
      try {
        audioContext.current ??= new AudioContext();
        void audioContext.current.resume().catch(() => setNotice('Could not enable notification sound in this browser.'));
      } catch {
        setNotice('Notification sound is not supported in this browser.');
        return;
      }
    }
    setPreferences((current) => ({ ...current, notificationSound: enabled }));
  }
  useEffect(() => {
    if (auth !== 'ready') return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && ['f', 'k'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.search-panel__query')?.focus(), 0);
        setMenu(null);
        setSettingsTarget(null);
        setGlobalSettingsOpen(false);
        setSidebarOpen(false);
        return;
      }
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        // An open menu or dialog absorbs Escape without dismissing the view beneath it.
        if (overlayOpen.current) {
          setMenu(null);
          setDialog(null);
          return;
        }
        setSearchOpen(false);
        setSettingsTarget(null);
        setGlobalSettingsOpen(false);
        setSidebarOpen(false);
        setJoinNetworkId(null);
        setJoinError('');
        setTopicEditing(false);
        setTopicError('');
        setRenameTarget(null);
        setUsersPanelOpen(false);
        return;
      }
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === '/' && !typing && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const input = document.querySelector<HTMLInputElement>('.composer input');
        if (input) {
          event.preventDefault();
          window.dispatchEvent(new Event('lingo:slash'));
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
        case 'message': {
          if (receivedMessageIds.current.has(event.message.id)) break;
          const order = receivedMessageOrder.current;
          const slot = receivedMessageCursor.current % 2000;
          const expired = order[slot];
          if (expired !== undefined) receivedMessageIds.current.delete(expired);
          order[slot] = event.message.id;
          receivedMessageIds.current.add(event.message.id);
          receivedMessageCursor.current++;
          messageQueue.current.push(event.message);
          if (messageFrame.current === null) {
            messageFrame.current = requestAnimationFrame(() => {
              messageFrame.current = null;
              const queued = messageQueue.current;
              messageQueue.current = [];
              const selectedBufferId = selectedRef.current;
              if (selectedBufferId !== null && !jumpRef.current) {
                const selectedMessages = queued.filter((message) => message.bufferId === selectedBufferId);
                if (selectedMessages.length) setView((current) => current.bufferId === selectedBufferId
                  ? { ...current, messages: mergeMessages(current.messages, selectedMessages) }
                  : current);
              }
            });
          }
          const buffer = buffersRef.current.find((item) => item.id === event.message.bufferId);
          if (buffer?.kind === 'query' && hiddenBuffersRef.current.includes(buffer.id)) {
            hiddenBuffersRef.current = hiddenBuffersRef.current.filter((id) => id !== buffer.id);
            setHiddenBuffers(hiddenBuffersRef.current);
          }
          const network = buffer && networksRef.current.find((item) => item.id === buffer.networkId);
          const identity = network && event.message.nick
            ? displayIdentity(event.message, network.relayNicks, network.displayNames) : null;
          const ownNames = network
            ? [...new Set([statusesRef.current[network.id]?.nick, network.nick, ...network.mentionAliases].filter(Boolean))] as string[]
            : [];
          const sender = identity?.mentionTarget ?? event.message.nick;
          const inbound = !!identity && !!sender && (event.message.kind === 'privmsg'
            || event.message.kind === 'action' || event.message.kind === 'notice')
            && !ownNames.some((name) => name.toLowerCase() === sender.toLowerCase());
          const highlight = inbound && identity !== null && (mentionsAny(identity.text, ownNames)
            || preferencesRef.current.highlights.some((phrase) => identity.text.toLowerCase().includes(phrase.toLowerCase())));
          const muted = mutedRef.current.buffers.includes(event.message.bufferId)
            || (!!buffer && mutedRef.current.networks.includes(buffer.networkId));
          if (!muted && (selectedRef.current !== event.message.bufferId || jumpRef.current)) {
            setUnread((current) => ({ ...current, [event.message.bufferId]: (current[event.message.bufferId] ?? 0) + 1 }));
            if (highlight || inbound && buffer?.kind === 'query') {
              setMentionUnread((current) => ({ ...current, [event.message.bufferId]: (current[event.message.bufferId] ?? 0) + 1 }));
            }
          }
          if (!muted && identity && inbound && (highlight || buffer?.kind === 'query')) {
            const settings = preferencesRef.current;
            if (settings.browserNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              try {
                const notification = new Notification(`${identity.nick ?? sender} · ${buffer?.name ?? network?.name ?? 'IRC'}`, {
                  body: identity.text,
                  tag: `lingo-message-${event.message.id}`,
                });
                notification.onclick = () => {
                  window.focus();
                  setSelectedId(event.message.bufferId);
                  setSettingsTarget(null);
                  setGlobalSettingsOpen(false);
                  setSearchOpen(false);
                  notification.close();
                };
              } catch { /* Browser or OS may block notifications. */ }
            }
            if (settings.notificationSound) {
              try {
                const context = audioContext.current ??= new AudioContext();
                if (context.state === 'suspended') void context.resume().catch(() => {});
                const oscillator = context.createOscillator();
                const volume = context.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.value = 740;
                volume.gain.setValueAtTime(0.0001, context.currentTime);
                volume.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
                volume.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
                oscillator.connect(volume);
                volume.connect(context.destination);
                oscillator.start();
                oscillator.stop(context.currentTime + 0.19);
              } catch { /* An unavailable audio device must not interrupt messages. */ }
            }
          }
          if (!buffer) {
            void refreshBootstrap(controller.signal).then((data) => {
              if (controller.signal.aborted || !data.buffers.some((item) => item.id === event.message.bufferId && item.kind === 'query')) return;
              hiddenBuffersRef.current = hiddenBuffersRef.current.filter((id) => id !== event.message.bufferId);
              setHiddenBuffers(hiddenBuffersRef.current);
            }).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          }
          break;
        }
        case 'buffer':
          if (event.buffer.kind === 'query' && hiddenBuffersRef.current.includes(event.buffer.id)) {
            hiddenBuffersRef.current = hiddenBuffersRef.current.filter((id) => id !== event.buffer.id);
            setHiddenBuffers(hiddenBuffersRef.current);
          }
          setBuffers((current) => current.some((buffer) => buffer.id === event.buffer.id)
            ? current.map((buffer) => buffer.id === event.buffer.id ? event.buffer : buffer)
            : [...current, event.buffer]);
          break;
        case 'buffer_removed': {
          const remaining = buffersRef.current.filter((buffer) => buffer.id !== event.bufferId);
          setBuffers(remaining);
          setSelectedId((selected) => selected === event.bufferId ? (remaining[0]?.id ?? null) : selected);
          setUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
          setMentionUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
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
          setChannelListTabs((current) => current.filter((id) => id !== event.networkId));
          setChannelListView((current) => current === event.networkId ? null : current);
          break;
        }
        case 'channel_state':
          if (selectedRef.current === event.state.bufferId) {
            channelStateVersion.current++;
            setChannelDetails({ bufferId: event.state.bufferId, state: event.state, loading: false, error: '' });
          }
          break;
        case 'history_cleared':
          setView((current) => current.bufferId === event.bufferId ? { ...current, messages: [], hasMore: false } : current);
          setJump((current) => current?.bufferId === event.bufferId ? null : current);
          setUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
          setMentionUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
          break;
        case 'channel_list':
          setChannelLists((current) => ({ ...current, [event.status.networkId]: event.status }));
          break;
        case 'ignores':
          setIgnores((current) => ({ ...current, [event.networkId]: event.ignores }));
          break;
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
      if (messageFrame.current !== null) cancelAnimationFrame(messageFrame.current);
      messageFrame.current = null;
      messageQueue.current = [];
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
    setMentionUnread((current) => {
      if (bufferId === null || !current[bufferId]) return current;
      const next = { ...current }; delete next[bufferId]; return next;
    });
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
  useEffect(() => {
    const controller = new AbortController();
    const version = ++channelStateVersion.current;
    setTopicEditing(false);
    setTopicError('');
    setUsersPanelOpen(false);
    if (auth !== 'ready' || selectedChannelId === null || !channelJoined || !channelConnected) {
      setChannelDetails(null);
      return () => controller.abort();
    }
    setChannelDetails({ bufferId: selectedChannelId, state: null, loading: true, error: '' });
    void api<ChannelState>(`/api/buffers/${selectedChannelId}/channel`, { signal: controller.signal })
      .then((state) => {
        if (!controller.signal.aborted && channelStateVersion.current === version) {
          setChannelDetails({ bufferId: selectedChannelId, state, loading: false, error: '' });
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && channelStateVersion.current === version) {
          setChannelDetails({ bufferId: selectedChannelId, state: null, loading: false, error: errorText(error) });
        }
      });
    return () => controller.abort();
  }, [auth, selectedChannelId, channelJoined, channelConnected]);
  useEffect(() => {
    const target = pendingTopicEdit.current;
    if (target === null || channelDetails?.bufferId !== target || !channelDetails.state) return;
    pendingTopicEdit.current = null;
    setTopicDraft(channelDetails.state.topic ?? '');
    setTopicError('');
    setTopicEditing(true);
  }, [channelDetails]);

  function selectBuffer(id: number) {
    hiddenBuffersRef.current = hiddenBuffersRef.current.filter((bufferId) => bufferId !== id);
    setHiddenBuffers(hiddenBuffersRef.current);
    setMenu(null);
    setChannelListView(null);
    setJump(null);
    setSelectedId(id);
    setRenameTarget(null);
    setSearchOpen(false);
    setSettingsTarget(null);
    setGlobalSettingsOpen(false);
    setSidebarOpen(false);
    setNotice('');
    setUnread((current) => { const next = { ...current }; delete next[id]; return next; });
    setMentionUnread((current) => { const next = { ...current }; delete next[id]; return next; });
    document.querySelector<HTMLInputElement>('.composer input')?.focus();
  }

  async function loadOlder() {
    if (olderRequest.current || view.bufferId !== selectedId || selectedId === null || view.loading || !view.hasMore) return;
    const oldest = view.messages[0]?.id;
    if (oldest === undefined) return;
    const currentGeneration = generation.current;
    const request = { bufferId: selectedId, controller: new AbortController() };
    olderRequest.current = request;
    setOlderPending(true);
    setNotice('');
    try {
      const page = await messagePage(selectedId, oldest, request.controller.signal);
      if (generation.current !== currentGeneration || selectedRef.current !== selectedId) return;
      setView((current) => current.bufferId !== selectedId ? current : {
        ...current, messages: mergeMessages(current.messages, page.messages), hasMore: page.hasMore,
      });
    } catch (error) {
      if (!request.controller.signal.aborted && generation.current === currentGeneration
        && selectedRef.current === selectedId) fail(error);
    } finally {
      if (olderRequest.current === request) {
        olderRequest.current = null;
        setOlderPending(false);
      }
    }
  }

  async function sendMessage(text: string) {
    if (selectedId === null || sending || !text.trim()) return;
    setSending(true);
    setNotice('');
    try {
      await api<{ ok: true }>('/api/send', json('POST', { bufferId: selectedId, text }));
      const networkId = buffers.find((buffer) => buffer.id === selectedId)?.networkId;
      if (networkId !== undefined && /^\/list(?:\s|$)/i.test(text.trim())) openChannelList(networkId, false);
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      setSending(false);
    }
  }

  async function renameNick(mentionTarget: string, displayName: string) {
    const network = activeNetwork;
    if (!network) return;
    const canonicalKey = mentionTarget.toLowerCase();
    const displayNames = { ...network.displayNames };
    for (const key of Object.keys(displayNames)) {
      if (key.toLowerCase() === canonicalKey) delete displayNames[key];
    }
    if (displayName.trim()) displayNames[canonicalKey] = displayName.trim();
    const input: NetworkInput = {
      name: network.name,
      host: network.host,
      port: network.port,
      tls: network.tls,
      nick: network.nick,
      username: network.username,
      realname: network.realname,
      saslAccount: network.saslAccount,
      autojoin: network.autojoin,
      commands: network.commands,
      relayNicks: network.relayNicks,
      mentionAliases: network.mentionAliases,
      displayNames,
    };
    setNotice('');
    try {
      await api<Network>(`/api/networks/${network.id}`, json('PATCH', input));
      await refreshBootstrap();
      setRenameTarget(null);
      setRenameValue('');
    } catch (error) {
      fail(error);
    }
  }

  function beginRename(mentionTarget: string) {
    if (!activeNetwork) return;
    const canonicalKey = mentionTarget.toLowerCase();
    const existing = Object.entries(activeNetwork.displayNames)
      .find(([key]) => key.toLowerCase() === canonicalKey)?.[1] ?? '';
    setRenameTarget({ networkId: activeNetwork.id, nick: canonicalKey });
    setRenameValue(existing);
  }
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joinNetworkId === null || joining) return;
    const names = joinName.trim().split(/[,\s]+/).filter(Boolean);
    if (!names.length || names.length > 20 || names.some((name) => name.length > 100
      || !/^[#&+!][^\s,\x00-\x1f\x7f]+$/.test(name))
      || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      setJoinError('Enter 1–20 distinct channel names, each starting with #, &, + or ! (for example #one, #two).');
      return;
    }
    setJoining(true);
    setJoinError('');
    const networkId = joinNetworkId;
    try {
      const { buffers: joined } = await api<{ buffers: ChatBuffer[] }>('/api/buffers/batch',
        json('POST', { networkId, names }));
      setBuffers((current) => {
        const updated = [...current];
        for (const buffer of joined) {
          const index = updated.findIndex((item) => item.id === buffer.id);
          if (index < 0) updated.push(buffer);
          else updated[index] = buffer;
        }
        return updated;
      });
      hiddenBuffersRef.current = hiddenBuffersRef.current.filter((id) => !joined.some((buffer) => buffer.id === id));
      setHiddenBuffers(hiddenBuffersRef.current);
      setCollapsedNetworks((current) => current.filter((id) => id !== networkId));
      await refreshBootstrap();
      setJoinName('');
      setJoinNetworkId(null);
      if (joined.length) selectBuffer(joined[joined.length - 1].id);
    } catch (error) {
      setJoinError(errorText(error));
    } finally {
      setJoining(false);
    }
  }

  async function joinChannel(networkId: number, name: string) {
    if (joining) return;
    setJoining(true);
    setNotice('');
    try {
      const joined = await api<ChatBuffer>('/api/buffers', json('POST', { networkId, name }));
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
  async function closeBuffer(buffer: ChatBuffer) {
    if (buffer.kind === 'server') return;
    setMenu(null);
    setNotice('');
    try {
      if (buffer.kind === 'channel' && isJoined(networks.find((item) => item.id === buffer.networkId), buffer.name)) {
        await api<unknown>(`/api/buffers/${buffer.id}`, { method: 'DELETE' });
      }
      hiddenBuffersRef.current = [...new Set([...hiddenBuffersRef.current, buffer.id])];
      setHiddenBuffers(hiddenBuffersRef.current);
      if (selectedRef.current === buffer.id) {
        setJump(null);
        setSelectedId((buffers.find((item) => item.networkId === buffer.networkId && item.kind === 'server')
          ?? buffers.find((item) => item.id !== buffer.id && !hiddenBuffersRef.current.includes(item.id)))?.id ?? null);
      }
      if (buffer.kind === 'channel') await refreshBootstrap();
    } catch (error) {
      fail(error);
    }
  }
  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedChannelId === null || !channelJoined || !channelConnected || topicSaving) return;
    setTopicSaving(true);
    setTopicError('');
    try {
      await api<{ ok: true }>(`/api/buffers/${selectedChannelId}/topic`, json('PATCH', { topic: topicDraft }));
      setTopicEditing(false);
    } catch (error) {
      setTopicError(errorText(error));
    } finally {
      setTopicSaving(false);
    }
  }

  function beginTopicEdit(buffer: ChatBuffer) {
    pendingTopicEdit.current = buffer.id;
    if (selectedId !== buffer.id || channelListView !== null) selectBuffer(buffer.id);
    // Already showing this channel: the details effect will not fire again, so apply now.
    else if (channelDetails?.bufferId === buffer.id && channelDetails.state) {
      pendingTopicEdit.current = null;
      setTopicDraft(channelDetails.state.topic ?? '');
      setTopicError('');
      setTopicEditing(true);
    }
  }

  function openChannelList(networkId: number, refresh: boolean) {
    setChannelListTabs((current) => current.includes(networkId) ? current : [...current, networkId]);
    setCollapsedNetworks((current) => current.filter((id) => id !== networkId));
    setChannelListView(networkId);
    setSearchOpen(false);
    setSettingsTarget(null);
    setGlobalSettingsOpen(false);
    setSidebarOpen(false);
    if (refresh) void refreshChannelList(networkId);
  }

  async function refreshChannelList(networkId: number) {
    try {
      await api<{ ok: true }>(`/api/networks/${networkId}/channels/refresh`, json('POST', {}));
    } catch (error) {
      fail(error);
    }
  }

  function closeChannelList(networkId: number) {
    setChannelListTabs((current) => current.filter((id) => id !== networkId));
    if (channelListView === networkId) setChannelListView(null);
  }

  async function setNetworkConnected(networkId: number, connected: boolean) {
    setNotice('');
    try {
      await api<{ ok: true }>(`/api/networks/${networkId}/${connected ? 'connect' : 'disconnect'}`, { method: 'POST' });
    } catch (error) {
      fail(error);
    }
  }

  async function removeNetwork(network: Network) {
    if (!window.confirm(`Remove ${network.name} and all of its history?`)) return;
    try {
      await deleteNetwork(network.id);
    } catch (error) {
      fail(error);
    }
  }

  async function clearHistory(buffer: ChatBuffer) {
    if (!window.confirm(`Permanently delete all stored messages in ${buffer.name}?`)) return;
    setNotice('');
    try {
      await api<{ ok: true }>(`/api/buffers/${buffer.id}/messages`, { method: 'DELETE' });
    } catch (error) {
      fail(error);
    }
  }

  async function openQuery(networkId: number, nick: string) {
    setNotice('');
    try {
      const buffer = await api<ChatBuffer>('/api/buffers/query', json('POST', { networkId, nick }));
      setBuffers((current) => current.some((item) => item.id === buffer.id) ? current : [...current, buffer]);
      setCollapsedNetworks((current) => current.filter((id) => id !== networkId));
      selectBuffer(buffer.id);
    } catch (error) {
      fail(error);
    }
  }

  async function setIgnored(networkId: number, nick: string, ignored: boolean) {
    setNotice('');
    try {
      const result = await api<{ ignores: string[] }>(`/api/networks/${networkId}/ignores`,
        json(ignored ? 'POST' : 'DELETE', { nick }));
      setIgnores((current) => ({ ...current, [networkId]: result.ignores }));
    } catch (error) {
      fail(error);
    }
  }

  function toggleId(setter: typeof setMutedBuffers, id: number) {
    setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function menuItems(target: MenuTarget): { label: string; items: MenuItem[] } | null {
    if (target.kind === 'network') {
      const network = networks.find((item) => item.id === target.networkId);
      if (!network) return null;
      const server = buffers.find((buffer) => buffer.networkId === network.id && buffer.kind === 'server');
      const offline = (statuses[network.id]?.state ?? 'disconnected') === 'disconnected';
      return { label: `${network.name} actions`, items: [
        { label: network.name, heading: true, onSelect: server ? () => selectBuffer(server.id) : undefined },
        { label: 'Edit this network', onSelect: () => {
          setSettingsTarget(network.id); setSearchOpen(false); setGlobalSettingsOpen(false); setSidebarOpen(false);
        } },
        { label: 'Join a channel', onSelect: () => {
          setCollapsedNetworks((current) => current.filter((id) => id !== network.id));
          setJoinNetworkId(network.id);
          setJoinError('');
        } },
        { label: 'List all channels', disabled: offline, onSelect: () => openChannelList(network.id, true) },
        { label: 'List ignored users', onSelect: () => setDialog({ kind: 'ignores', networkId: network.id }) },
        offline
          ? { label: 'Connect', onSelect: () => void setNetworkConnected(network.id, true) }
          : { label: 'Disconnect', onSelect: () => void setNetworkConnected(network.id, false) },
        { label: mutedNetworks.includes(network.id) ? 'Unmute network' : 'Mute network',
          onSelect: () => toggleId(setMutedNetworks, network.id) },
        { label: 'Remove', danger: true, onSelect: () => void removeNetwork(network) },
      ] };
    }
    if (target.kind === 'user') {
      const ignored = (ignores[target.networkId] ?? []).some((nick) => nick.toLowerCase() === target.nick.toLowerCase());
      return { label: `${target.nick} actions`, items: [
        { label: target.nick, heading: true },
        { label: 'User info', onSelect: () => setDialog({ kind: 'whois', networkId: target.networkId, nick: target.nick }) },
        { label: 'Direct message', onSelect: () => void openQuery(target.networkId, target.nick) },
        { label: ignored ? 'Unignore user' : 'Ignore user', danger: !ignored,
          onSelect: () => void setIgnored(target.networkId, target.nick, !ignored) },
      ] };
    }
    const buffer = buffers.find((item) => item.id === target.bufferId);
    if (!buffer || buffer.kind === 'server') return null;
    const network = networks.find((item) => item.id === buffer.networkId);
    const muteLabel = `${mutedBuffers.includes(buffer.id) ? 'Unmute' : 'Mute'} ${buffer.kind === 'channel' ? 'channel' : 'conversation'}`;
    if (buffer.kind === 'query') {
      return { label: `${buffer.name} actions`, items: [
        { label: buffer.name, heading: true, onSelect: () => selectBuffer(buffer.id) },
        { label: 'User info', onSelect: () => setDialog({ kind: 'whois', networkId: buffer.networkId, nick: buffer.name }) },
        { label: 'Clear history', onSelect: () => void clearHistory(buffer) },
        { label: muteLabel, onSelect: () => toggleId(setMutedBuffers, buffer.id) },
        { label: 'Close conversation', onSelect: () => void closeBuffer(buffer) },
      ] };
    }
    const joined = isJoined(network, buffer.name);
    const live = joined && statuses[buffer.networkId]?.state === 'connected';
    return { label: `${buffer.name} actions`, items: [
      { label: buffer.name, heading: true, onSelect: () => selectBuffer(buffer.id) },
      { label: 'Edit topic', disabled: !live, onSelect: () => beginTopicEdit(buffer) },
      { label: 'List banned users', disabled: !live, onSelect: () => setDialog({ kind: 'bans', bufferId: buffer.id }) },
      { label: 'Clear history', onSelect: () => void clearHistory(buffer) },
      { label: muteLabel, onSelect: () => toggleId(setMutedBuffers, buffer.id) },
      joined
        ? { label: 'Leave', danger: true, onSelect: () => void part(buffer) }
        : { label: 'Rejoin', onSelect: () => void joinChannel(buffer.networkId, buffer.name) },
    ] };
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
    hiddenBuffersRef.current = hiddenBuffersRef.current.filter((id) => id !== message.bufferId);
    setHiddenBuffers(hiddenBuffersRef.current);
    setCollapsedNetworks((current) => current.filter((id) => id !== message.networkId));
    setMenu(null);
    setChannelListView(null);
    setJump({ bufferId: message.bufferId, messageId: message.id, serial: ++jumpSerial.current });
    setSelectedId(message.bufferId);
    setSearchOpen(false);
    setRenameTarget(null);
    setSidebarOpen(false);
    setSettingsTarget(null);
    setGlobalSettingsOpen(false);
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
        <ThemePicker theme={preferences.theme} onChange={(theme) => setPreferences((current) => ({ ...current, theme }))} />
      </div>
    </main>;
  }

  const selected = buffers.find((buffer) => buffer.id === selectedId) ?? null;
  const activeNetwork = networks.find((network) => network.id === selected?.networkId);
  const selectedJoined = selected?.kind !== 'channel' || isJoined(activeNetwork, selected.name);
  const settingsNetwork = typeof settingsTarget === 'number' ? networks.find((network) => network.id === settingsTarget) ?? null : null;
  const channelListNetwork = channelListView === null ? undefined : networks.find((network) => network.id === channelListView);
  const showingView = view.bufferId === selectedId;
  const messages = showingView ? view.messages : [];
  const showingConversation = settingsTarget === null && !searchOpen && !globalSettingsOpen && !channelListNetwork && !!selected;
  const selectedState = selected ? statuses[selected.networkId]?.state ?? 'disconnected' : 'disconnected';
  const selectedDetails = selected && channelDetails?.bufferId === selected.id ? channelDetails : null;
  const topic = selectedDetails?.state?.topic || '';
  const menuSpec = menu && menuItems(menu);
  const dialogNetwork = dialog && dialog.kind !== 'bans' ? networks.find((network) => network.id === dialog.networkId) : undefined;
  const dialogBuffer = dialog?.kind === 'bans' ? buffers.find((buffer) => buffer.id === dialog.bufferId) : undefined;

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-menu" type="button" aria-label="Toggle networks" aria-expanded={sidebarOpen}
          onClick={() => { setSidebarOpen((open) => !open); setGlobalSettingsOpen(false); }}>☰</button>
        <span className="brand">lingo<span className="brand-cursor">_</span></span>
        <span className={`transport transport-${connection}`} role="status" aria-label={`Live updates ${connection}`}>
          <span className="status-dot" />{connection === 'live' ? 'live' : connection === 'offline' ? 'reconnecting' : 'connecting'}
        </span>
      </div>
      <div className="topbar-actions">
        <button className="button button-quiet" type="button" title="Search history (Ctrl+F or ⌘F)"
          onClick={() => { setSearchOpen(true); setSettingsTarget(null); setGlobalSettingsOpen(false); setSidebarOpen(false); }}>Search <kbd>⌕</kbd></button>
        <button className="button button-quiet" type="button" onClick={() => { setSettingsTarget('new'); setSearchOpen(false); setGlobalSettingsOpen(false); setSidebarOpen(false); }}>Add network</button>
        <button className="button button-quiet" type="button" aria-expanded={globalSettingsOpen}
          onClick={() => { setGlobalSettingsOpen((open) => !open); setSettingsTarget(null); setSearchOpen(false); setSidebarOpen(false); }}>
          Settings
        </button>
        <button className="button button-quiet logout-button" type="button" onClick={() => void logout()}>Sign out</button>
      </div>
    </header>
    <div className="workspace">
      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close networks" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`} aria-label="Networks and buffers">
        <div className="sidebar-heading"><span>NETWORKS</span><button type="button" className="icon-button" aria-label="Add network" title="Add network"
          onClick={() => { setSettingsTarget('new'); setSearchOpen(false); setGlobalSettingsOpen(false); setSidebarOpen(false); }}>+</button></div>
        {networks.length === 0 && <div className="sidebar-empty">No networks yet.<button className="text-button" type="button"
          onClick={() => { setSettingsTarget('new'); setSearchOpen(false); setGlobalSettingsOpen(false); setSidebarOpen(false); }}>Set one up →</button></div>}
        {networks.map((network) => {
          const status = statuses[network.id];
          const state = status?.state ?? 'disconnected';
          const server = buffers.find((buffer) => buffer.networkId === network.id && buffer.kind === 'server');
          const networkBuffers = buffers.filter((buffer) => buffer.networkId === network.id
            && buffer.kind !== 'server' && !hiddenBuffers.includes(buffer.id))
            .sort((a, b) => a.name.localeCompare(b.name));
          const collapsed = collapsedNetworks.includes(network.id);
          const networkMuted = mutedNetworks.includes(network.id);
          return <section className={`network-group${networkMuted ? ' network-muted' : ''}`} key={network.id} aria-label={`${network.name} network`}>
            <div className="network-heading" onContextMenu={(event) => openMenu(event, { kind: 'network', networkId: network.id })}>
              <span className={`status-dot status-${state}`} title={status?.error || state} aria-label={state} />
              <button className="network-collapse" type="button" aria-expanded={!collapsed}
                aria-controls={`network-buffers-${network.id}`}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${network.name} channels`}
                onClick={() => setCollapsedNetworks((current) => collapsed
                  ? current.filter((id) => id !== network.id) : [...current, network.id])}>
                <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
              </button>
              {server && <button className={`network-server${selectedId === server.id ? ' buffer-active' : ''}`}
                type="button" aria-current={selectedId === server.id ? 'page' : undefined}
                onClick={() => selectBuffer(server.id)}>
                <span className="network-server-prefix" aria-hidden="true">⌁</span>
                <span className="network-name">{network.name}</span>
                {!!mentionUnread[server.id] && <span className="unread-badge mention-badge"
                  aria-label={`${mentionUnread[server.id]} unread mentions`}>{mentionUnread[server.id]}</span>}
                {!!unread[server.id] && <span className="unread-badge"
                  aria-label={`${unread[server.id]} unread messages`}>{unread[server.id]}</span>}
              </button>}
              <button className="icon-button network-action" type="button" aria-label={`Join channel on ${network.name}`} title="Join channel"
                onClick={() => {
                  setJoinNetworkId(joinNetworkId === network.id ? null : network.id);
                  setJoinError('');
                  setGlobalSettingsOpen(false);
                }}>+</button>
              <button className="icon-button network-action" type="button" aria-label={`Edit ${network.name}`} title="Network settings"
                onClick={() => { setSettingsTarget(network.id); setSearchOpen(false); setGlobalSettingsOpen(false); setSidebarOpen(false); }}>⚙</button>
            </div>
            {!collapsed && status?.error && <span className="network-error" title={status.error}>{status.error}</span>}
            {joinNetworkId === network.id && <form className="join-form" onSubmit={join}>
              <label className="sr-only" htmlFor={`join-${network.id}`}>Channels to join on {network.name}</label>
              <input id={`join-${network.id}`} autoFocus value={joinName} onChange={(event) => { setJoinName(event.target.value); setJoinError(''); }}
                placeholder="#one, #two" autoComplete="off" disabled={joining} aria-invalid={!!joinError}
                aria-describedby={joinError ? `join-error-${network.id}` : undefined} />
              <button className="button button-primary" type="submit" disabled={joining || !joinName.trim()}>{joining ? '…' : 'Join'}</button>
              {joinError && <span className="error-text" id={`join-error-${network.id}`} role="alert">{joinError}</span>}
            </form>}
            {!collapsed && <nav className="buffer-list" id={`network-buffers-${network.id}`} aria-label={`${network.name} buffers`}>
              {channelListTabs.includes(network.id) && <div className="buffer-entry">
                <button type="button" className={`buffer-item${channelListView === network.id ? ' buffer-active' : ''}`}
                  aria-current={channelListView === network.id ? 'page' : undefined}
                  onClick={() => openChannelList(network.id, false)}>
                  <span className="buffer-prefix" aria-hidden="true">≡</span>
                  <span className="buffer-name">channel list</span>
                  {channelLists[network.id]?.state === 'loading' && <span className="buffer-loading" aria-label="Loading">…</span>}
                </button>
                <button type="button" className="buffer-close" aria-label={`Close channel list for ${network.name}`}
                  title="Close channel list" onClick={() => closeChannelList(network.id)}>×</button>
              </div>}
              {networkBuffers.map((buffer) => {
                const parted = buffer.kind === 'channel' && !isJoined(network, buffer.name);
                const muted = networkMuted || mutedBuffers.includes(buffer.id);
                return <div className={`buffer-entry${muted ? ' buffer-muted' : ''}`} key={buffer.id}
                  onContextMenu={(event) => openMenu(event, { kind: 'buffer', bufferId: buffer.id })}>
                  <button type="button" className={`buffer-item${selectedId === buffer.id && channelListView === null ? ' buffer-active' : ''}`}
                    aria-current={selectedId === buffer.id && channelListView === null ? 'page' : undefined} onClick={() => selectBuffer(buffer.id)}>
                    <span className="buffer-prefix">{buffer.kind === 'channel' ? '#' : buffer.kind === 'query' ? '@' : '⌁'}</span>
                    <span className="buffer-name">{buffer.kind === 'channel' ? buffer.name.replace(/^#/, '') : buffer.name}</span>
                    {!!mentionUnread[buffer.id] && <span className="unread-badge mention-badge"
                      aria-label={`${mentionUnread[buffer.id]} unread mentions`}>{mentionUnread[buffer.id]}</span>}
                    {!!unread[buffer.id] && <span className="unread-badge"
                      aria-label={`${unread[buffer.id]} unread messages`}>{unread[buffer.id]}</span>}
                  </button>
                  {parted && <button type="button" className="buffer-rejoin" disabled={joining}
                    aria-label={`Rejoin ${buffer.name} on ${network.name}`} onClick={() => void joinChannel(buffer.networkId, buffer.name)}>↻</button>}
                  <button type="button" className="buffer-close"
                    aria-label={`Close ${buffer.name} on ${network.name}`} title={`Close ${buffer.name}`}
                    onClick={() => void closeBuffer(buffer)}>×</button>
                </div>;
              })}
            </nav>}
          </section>;
        })}
      </aside>
      <main className="main-pane">
        {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" type="button" aria-label="Dismiss error" onClick={() => setNotice('')}>×</button></div>}
        {settingsTarget !== null ? <div className="panel-scroll"><NetworkSettings key={settingsTarget} network={settingsNetwork}
          onSave={saveNetwork} onDelete={deleteNetwork} onClose={() => setSettingsTarget(null)} /></div>
        : searchOpen ? <SearchPanel networks={networks} buffers={buffers} initialBufferId={selectedId ?? undefined}
          onClose={() => setSearchOpen(false)} onJump={jumpTo} />
        : globalSettingsOpen ? <div className="panel-scroll"><GlobalSettings preferences={preferences}
          onChange={setPreferences} onEnableNotifications={enableNotifications} onSoundChange={changeSound}
          onClose={() => setGlobalSettingsOpen(false)} onUnauthorized={() => {
            setAuth('login');
            setLoginError('Your session expired. Sign in again.');
            setGlobalSettingsOpen(false);
          }} /></div>
        : channelListNetwork ? <ChannelListPanel key={channelListNetwork.id} network={channelListNetwork}
          status={channelLists[channelListNetwork.id]}
          connected={statuses[channelListNetwork.id]?.state === 'connected'}
          isJoined={(name) => isJoined(channelListNetwork, name)}
          onJoin={(name) => void joinChannel(channelListNetwork.id, name)}
          onRefresh={() => void refreshChannelList(channelListNetwork.id)}
          onClose={() => closeChannelList(channelListNetwork.id)} onUnauthorized={sessionExpired} />
        : selected ? <>
          <header className="conversation-header">
            <div className="conversation-title">
              {renameTarget && renameTarget.networkId === activeNetwork?.id && <form className="nick-rename" onSubmit={(event) => {
                event.preventDefault();
                void renameNick(renameTarget.nick, renameValue);
              }}>
                <label className="sr-only" htmlFor="nick-display-name">Display name for {renameTarget.nick}</label>
                <span aria-hidden="true">{renameTarget.nick}</span>
                <input id="nick-display-name" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)}
                  placeholder="Display name" maxLength={64} />
                <button className="button button-primary" type="submit">Save</button>
                <button className="button button-quiet" type="button" onClick={() => setRenameTarget(null)}>Cancel</button>
              </form>}
              <div className="conversation-heading">
                <h1>{selected.name}</h1>
                {selected.kind === 'channel' && topicEditing
                  ? <form className="channel-topic-editor" onSubmit={(event) => void saveTopic(event)}>
                    <label className="sr-only" htmlFor="channel-topic-input">Topic for {selected.name}</label>
                    <input id="channel-topic-input" autoFocus value={topicDraft} placeholder="Topic"
                      onChange={(event) => setTopicDraft(event.target.value)} disabled={topicSaving} />
                    <button className="button button-primary" type="submit" disabled={topicSaving}>
                      {topicSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="button button-quiet" type="button" disabled={topicSaving}
                      onClick={() => { setTopicEditing(false); setTopicError(''); }}>Cancel</button>
                    {topicError && <span className="error-text" role="alert">{topicError}</span>}
                  </form>
                  : topic && <p className="conversation-topic" title={topic}
                    onDoubleClick={() => { if (selected.kind === 'channel') beginTopicEdit(selected); }}>{topic}</p>}
              </div>
            </div>
            <div className="conversation-actions">
              {jump && jump.bufferId === selected.id && <button className="button button-quiet" type="button" onClick={() => setJump(null)}>Back to latest</button>}
              {selected.kind === 'channel' && !selectedJoined && <button className="button button-primary"
                type="button" onClick={() => void joinChannel(selected.networkId, selected.name)} disabled={joining}>
                {joining ? 'Joining…' : 'Rejoin'}
              </button>}
              {selected.kind === 'channel' && <button className="button button-quiet users-toggle" type="button"
                aria-expanded={usersPanelOpen} onClick={() => setUsersPanelOpen((open) => !open)}>
                Users{selectedDetails?.state ? ` (${selectedDetails.state.users.length})` : ''}
              </button>}
            </div>
          </header>
          <div className="conversation-meta">
            <span className={`status-dot status-${selectedState}`} />
            {selectedState}
            {statuses[selected.networkId]?.nick && <span>as {statuses[selected.networkId].nick}</span>}
            {jump && jump.bufferId === selected.id && <span className="history-indicator">Viewing search result</span>}
            {selected.kind === 'channel' && !selectedJoined && <span className="buffer-state">Parted — history is retained</span>}
          </div>
          <Transcript buffer={selected} network={activeNetwork!} messages={messages}
            ownNames={[...new Set([statuses[selected.networkId]?.nick, activeNetwork?.nick, ...(activeNetwork?.mentionAliases ?? [])].filter(Boolean))] as string[]}
            loading={!showingView || view.loading} hasMore={showingView && view.hasMore} olderPending={olderPending}
            error={showingView ? view.error : ''} jumpId={jump?.bufferId === selected.id ? jump.messageId : null}
            onLoadOlder={loadOlder} onRetry={() => setReloadSerial((current) => current + 1)}
            onRename={beginRename} onNickMenu={(nick, x, y) => setMenu({ kind: 'user', networkId: selected.networkId, nick, x, y })}
            preferences={preferences} theme={preferences.theme} />
          <MentionComposer buffer={selected} disabled={!selectedJoined || sending}
            knownChannels={buffers.filter((buffer) => buffer.networkId === selected.networkId && buffer.kind === 'channel')
              .map((buffer) => buffer.name)}
            channelListUpdatedAt={channelLists[selected.networkId]?.updatedAt ?? null}
            onSend={sendMessage} onError={(error) => setNotice(errorText(error))} autocomplete={preferences.autocomplete} />
        </> : <div className="welcome">
          <span className="welcome-glyph" aria-hidden="true">&gt;_</span>
          <h1>{networks.length ? 'Select a buffer' : 'Connect to IRC'}</h1>
          <p>{networks.length ? 'Choose a network or join a channel to start reading.' : 'Add a network to keep your channels and history in one place.'}</p>
          {!networks.length && <button className="button button-primary" type="button" onClick={() => {
            setSettingsTarget('new');
            setSearchOpen(false);
            setGlobalSettingsOpen(false);
          }}>Add your first network</button>}
        </div>}
      </main>
      {showingConversation && selected.kind === 'channel' && <>
        {usersPanelOpen && <button className="user-panel-scrim" type="button" aria-label="Close users"
          onClick={() => setUsersPanelOpen(false)} />}
        <UserList key={selected.id} channel={selected.name} open={usersPanelOpen} onClose={() => setUsersPanelOpen(false)}
          nickTheme={preferences.coloredNicknames ? preferences.theme : null}
          users={selectedDetails?.state?.users ?? null}
          message={!selectedJoined ? 'Users are unavailable while parted.'
            : !channelConnected ? `Users are unavailable while ${selectedState}.`
              : selectedDetails?.error || 'Loading users…'}
          onUserMenu={(nick, x, y) => setMenu({ kind: 'user', networkId: selected.networkId, nick, x, y })} />
      </>}
    </div>
    {menu && menuSpec && <ContextMenu key={JSON.stringify(menu)} x={menu.x} y={menu.y}
      label={menuSpec.label} items={menuSpec.items} onClose={() => setMenu(null)} />}
    {dialog?.kind === 'whois' && dialogNetwork && <WhoisDialog network={dialogNetwork} nick={dialog.nick}
      onClose={() => setDialog(null)} onMessage={(nick) => void openQuery(dialogNetwork.id, nick)} onUnauthorized={sessionExpired} />}
    {dialog?.kind === 'bans' && dialogBuffer && <BanListDialog buffer={dialogBuffer}
      onClose={() => setDialog(null)} onUnauthorized={sessionExpired} />}
    {dialog?.kind === 'ignores' && dialogNetwork && <IgnoreListDialog network={dialogNetwork}
      ignores={ignores[dialogNetwork.id] ?? []}
      onChange={(next) => setIgnores((current) => ({ ...current, [dialogNetwork.id]: next }))}
      onClose={() => setDialog(null)} onUnauthorized={sessionExpired} />}
  </div>;
}
