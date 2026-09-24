import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type {
  AccountUser, Bootstrap, BufferUnread, ChannelListStatus, ChannelState, ChatBuffer, ChatMessage, Network, NetworkInput,
  NetworkStatus, ServerEvent, SetupStatus, SyncedSettings,
} from '../shared/contracts';
import { displayIdentity } from '../shared/identity';
import { api, ApiError, errorText, json } from './api';
import AuthScreen, { type AuthMode } from './AuthScreen';
import ChannelListPanel from './ChannelListPanel';
import { isJoined, mergeMessages, messagePage, ownNames } from './chat';
import ContextMenu, { type MenuItem, type MenuSubject } from './ContextMenu';
import ConversationHeader from './ConversationHeader';
import { BanListDialog, DisplayNameDialog, IgnoreListDialog, WhoisDialog } from './Dialogs';
import Icon from './Icon';
import MentionComposer from './MentionComposer';
import { playChime } from './notify';
import PaneHeader, { SidebarContext, type SidebarControl } from './PaneHeader';
import { applyAppearance, loadPreferences, savePreferences, type AppPreferences } from './preferences';
import { forgetPush, pushSupported, registerServiceWorker, syncPush } from './push';
import SearchPanel from './SearchPanel';
import { rememberChannel } from './sessionRecents';
import GlobalSettings from './settings/GlobalSettings';
import NetworkSettings from './settings/NetworkSettings';
import Sidebar, { SidebarResizer } from './Sidebar';
import { clearLegacySettings, defaultSyncedSettings, legacySettings, savedIds } from './syncedSettings';
import Transcript from './Transcript';
import UserList from './UserList';

type ChannelDetails = { bufferId: number; state: ChannelState | null; loading: boolean; error: string };
type View = {
  bufferId: number | null;
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string;
};
type Jump = { bufferId: number; messageId: number; serial: number };
type MenuTarget = { subject: MenuSubject; x: number; y: number };
type DialogTarget =
  | { kind: 'whois'; networkId: number; nick: string }
  | { kind: 'bans'; bufferId: number }
  | { kind: 'ignores'; networkId: number }
  | { kind: 'displayName'; networkId: number; nick: string; initial: string };

/** Matches the stylesheet breakpoint where the networks sidebar becomes a drawer. */
const drawerLayout = '(max-width: 640px)';
/** Matches the stylesheet breakpoint where the channel user list becomes a drawer. */
const usersDrawerLayout = '(max-width: 900px)';

const launchUrl = new URL(window.location.href);
const initialSetupToken = launchUrl.searchParams.get('setup') ?? '';
// Push notification clicks open `/?buffer=<id>` when no Lingo window is open.
const launchBuffer = /^[1-9]\d*$/.test(launchUrl.searchParams.get('buffer') ?? '')
  ? Number(launchUrl.searchParams.get('buffer')) : null;
if (launchUrl.searchParams.has('setup') || launchUrl.searchParams.has('buffer')) {
  launchUrl.searchParams.delete('setup');
  launchUrl.searchParams.delete('buffer');
  window.history.replaceState(window.history.state, '', `${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function sameSubject(left: MenuSubject, right: MenuSubject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function App() {
  const [auth, setAuth] = useState<AuthMode | 'ready'>('checking');
  const [authMessage, setAuthMessage] = useState('');
  const [rememberedUsername, setRememberedUsername] = useState('');
  const [user, setUser] = useState<AccountUser | null>(null);
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
  const drawerSidebar = useMediaQuery(drawerLayout);
  const drawerUsers = useMediaQuery(usersDrawerLayout);
  const [joinTarget, setJoinTarget] = useState<number | null>(null);
  const [syncedSettings, setSyncedSettings] = useState<SyncedSettings>(defaultSyncedSettings);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [ignores, setIgnores] = useState<Record<number, string[]>>({});
  const [channelListTabs, setChannelListTabs] = useState<number[]>(() => savedIds('lingo-channel-lists'));
  const [channelListView, setChannelListView] = useState<number | null>(null);
  const [channelLists, setChannelLists] = useState<Record<number, ChannelListStatus>>({});
  const [joining, setJoining] = useState(false);
  const [channelDetails, setChannelDetails] = useState<ChannelDetails | null>(null);
  const [usersPanelOpen, setUsersPanelOpen] = useState(false);
  const [topicEditing, setTopicEditing] = useState(false);
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [unread, setUnread] = useState<Record<number, BufferUnread>>({});
  const [jump, setJump] = useState<Jump | null>(null);
  const [divider, setDivider] = useState<{ bufferId: number; after: number } | null>(null);
  const [reloadSerial, setReloadSerial] = useState(0);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const viewRef = useRef(view);
  viewRef.current = view;
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const unreadRef = useRef(unread);
  const recentMessages = useRef(new Map<number, { bufferId: number; mention: boolean }>());
  const readBottomRef = useRef<{ bufferId: number; atBottom: boolean } | null>(null);
  const readVisibleRef = useRef(false);
  const readPending = useRef<{ bufferId: number; messageId: number } | null>(null);
  const readTimer = useRef<number | null>(null);
  const readInFlight = useRef(false);
  const lastReadSentAt = useRef(0);
  const readGeneration = useRef(0);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const networksRef = useRef(networks);
  networksRef.current = networks;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const settingsRef = useRef<SyncedSettings>(syncedSettings);
  const serverSettingsRef = useRef<SyncedSettings>(defaultSyncedSettings);
  const pendingSettings = useRef<{ patch: Partial<SyncedSettings>; settle: (success: boolean) => void }[]>([]);
  const settingsSaving = useRef(false);
  const settingsGeneration = useRef(0);
  const settingsEventRevision = useRef(0);
  const settingsRevision = useRef(0);
  const migrationAttempted = useRef(new Set<number>());
  const userRef = useRef<AccountUser | null>(null);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  settingsRef.current = syncedSettings;
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
  const sidebarRef = useRef<HTMLElement>(null);

  const activeBuffer = buffers.find((buffer) => buffer.id === selectedId);
  const selectedChannelId = activeBuffer?.kind === 'channel' ? activeBuffer.id : null;
  const channelJoined = activeBuffer?.kind === 'channel'
    && isJoined(networks.find((network) => network.id === activeBuffer.networkId), activeBuffer.name);
  const channelConnected = activeBuffer?.kind === 'channel'
    && statuses[activeBuffer.networkId]?.state === 'connected';
  readVisibleRef.current = auth === 'ready' && settingsTarget === null && !searchOpen
    && !globalSettingsOpen && channelListView === null && jump === null;
  const updateUnread = useCallback((update: (current: Record<number, BufferUnread>) => Record<number, BufferUnread>) => {
    const next = update(unreadRef.current);
    if (next !== unreadRef.current) {
      unreadRef.current = next;
      setUnread(next);
    }
  }, []);
  const knownUnread = useCallback((bufferId: number, marker: number) => {
    let messages = 0;
    let mentions = 0;
    for (const [id, entry] of recentMessages.current) {
      if (entry.bufferId === bufferId && id > marker) {
        messages++;
        if (entry.mention) mentions++;
      }
    }
    return { messages, mentions, lastReadId: marker };
  }, []);
  const advanceRead = useCallback((bufferId: number, marker: number) => {
    const previous = unreadRef.current[bufferId]?.lastReadId ?? 0;
    if (marker <= previous) return false;
    updateUnread((current) => ({ ...current, [bufferId]: knownUnread(bufferId, marker) }));
    return true;
  }, [knownUnread, updateUnread]);
  const clearReadTimer = useCallback(() => {
    if (readTimer.current !== null) window.clearTimeout(readTimer.current);
    readTimer.current = null;
  }, []);
  const resetSyncedSettings = useCallback(() => {
    settingsGeneration.current++;
    settingsRevision.current++;
    settingsEventRevision.current++;
    userRef.current = null;
    for (const entry of pendingSettings.current) entry.settle(false);
    pendingSettings.current = [];
    serverSettingsRef.current = defaultSyncedSettings;
    readGeneration.current++;
    clearReadTimer();
    readPending.current = null;
    readBottomRef.current = null;
    readInFlight.current = false;
    recentMessages.current.clear();
    unreadRef.current = {};
    setUnread({});
    settingsRef.current = defaultSyncedSettings;
    setSyncedSettings(defaultSyncedSettings);
  }, [clearReadTimer]);
  const applyServerSettings = useCallback((settings: SyncedSettings) => {
    serverSettingsRef.current = settings;
    const next = { ...settings };
    for (const entry of pendingSettings.current) Object.assign(next, entry.patch);
    settingsRef.current = next;
    setSyncedSettings(next);
  }, []);
  const sessionExpired = useCallback(() => {
    bootstrapRequest.current++;
    const username = userRef.current?.username;
    resetSyncedSettings();
    if (username) setRememberedUsername(username);
    setAuth('login');
    setUser(null);
    setAuthMessage('Your session expired. Sign in again.');
    setDialog(null);
    setMenu(null);
  }, [resetSyncedSettings]);
  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) sessionExpired();
    else setNotice(errorText(error));
  }, [sessionExpired]);

  const saveSettings = useCallback(async (generation: number) => {
    if (settingsSaving.current) return;
    settingsSaving.current = true;
    try {
      while (generation === settingsGeneration.current && pendingSettings.current.length) {
        const entry = pendingSettings.current[0];
        const eventRevision = settingsEventRevision.current;
        try {
          const result = await api<SyncedSettings>('/api/settings', json('PATCH', entry.patch));
          if (generation !== settingsGeneration.current) return;
          pendingSettings.current.shift();
          if (settingsEventRevision.current === eventRevision) {
            settingsRevision.current++;
            applyServerSettings(result);
          } else applyServerSettings(serverSettingsRef.current);
          entry.settle(true);
        } catch (error) {
          if (generation !== settingsGeneration.current) return;
          pendingSettings.current.shift();
          applyServerSettings(serverSettingsRef.current);
          entry.settle(false);
          fail(error);
        }
      }
    } finally {
      settingsSaving.current = false;
      // An old account's request may finish after a new account has queued an edit.
      if (pendingSettings.current.length && generation !== settingsGeneration.current) {
        void saveSettings(settingsGeneration.current);
      }
    }
  }, [applyServerSettings, fail]);

  const updateSettings = useCallback((patch: Partial<SyncedSettings>): Promise<boolean> => {
    if (!userRef.current) return Promise.resolve(false);
    return new Promise<boolean>((settle) => {
      pendingSettings.current.push({ patch, settle });
      settingsRevision.current++;
      applyServerSettings(serverSettingsRef.current);
      void saveSettings(settingsGeneration.current);
    });
  }, [applyServerSettings, saveSettings]);
  function removeSettingId(field: 'hiddenBuffers' | 'collapsedNetworks', id: number) {
    const current = settingsRef.current[field];
    if (current.includes(id)) updateSettings({ [field]: current.filter((item) => item !== id) });
  }

  function toggleSettingId(field: 'mutedBuffers' | 'mutedNetworks' | 'collapsedNetworks', id: number) {
    const current = settingsRef.current[field];
    updateSettings({ [field]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  }

  /** Right-click opens at the pointer; buttons (and keyboard context menus) anchor below the element. Clicking the same button again closes it. */
  function openMenu(event: ReactMouseEvent<HTMLElement>, subject: MenuSubject) {
    event.preventDefault();
    if (event.type === 'click' && menu && sameSubject(menu.subject, subject)) {
      setMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = event.type === 'contextmenu' && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({ subject, x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom + 4 });
  }

  /** Closes every main-pane panel so the conversation (or the next panel) shows. */
  function closePanels() {
    setSettingsTarget(null);
    setSearchOpen(false);
    setGlobalSettingsOpen(false);
    setSidebarOpen(false);
  }

  function openSearch() {
    closePanels();
    setMenu(null);
    setSearchOpen(true);
  }

  function openNetworkSettings(target: number | 'new') {
    closePanels();
    setSettingsTarget(target);
  }

  function toggleSidebar() {
    if (drawerSidebar) {
      setSidebarOpen((open) => !open);
      setGlobalSettingsOpen(false);
    } else setPreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
  }

  function toggleUsers() {
    if (drawerUsers) setUsersPanelOpen((open) => !open);
    else setPreferences((current) => ({ ...current, userListHidden: !current.userListHidden }));
  }

  const refreshBootstrap = useCallback(async (signal?: AbortSignal) => {
    const request = ++bootstrapRequest.current;
    const settingsAtStart = settingsRevision.current;
    const accountAtStart = settingsGeneration.current;
    const data = await api<Bootstrap>('/api/bootstrap', { signal });
    if (signal?.aborted || request !== bootstrapRequest.current || accountAtStart !== settingsGeneration.current) return data;
    if (userRef.current && userRef.current.id !== data.user.id) resetSyncedSettings();
    userRef.current = data.user;
    if (settingsAtStart === settingsRevision.current || serverSettingsRef.current === defaultSyncedSettings) {
      applyServerSettings(data.settings);
      if (!data.settingsConfigured && !migrationAttempted.current.has(data.user.id)) {
        migrationAttempted.current.add(data.user.id);
        const userId = data.user.id;
        const generation = settingsGeneration.current;
        void (async () => {
          const recheckRevision = settingsRevision.current;
          const migrate = async () => {
            // Recheck under the cross-tab lock: another tab may have migrated after our bootstrap.
            const fresh = await api<Bootstrap>('/api/bootstrap');
            if (generation !== settingsGeneration.current || userRef.current?.id !== userId) return;
            if (fresh.settingsConfigured) {
              if (recheckRevision === settingsRevision.current) applyServerSettings(fresh.settings);
              return;
            }
            let owner: string | null = null;
            try { owner = localStorage.getItem('lingo-legacy-settings-owner'); } catch { /* Storage may be disabled. */ }
            if (owner !== null && owner !== String(userId)) return;
            const legacy = legacySettings();
            for (const field of ['mutedBuffers', 'hiddenBuffers'] as const) {
              if (legacy[field]) legacy[field] = legacy[field].filter((id) => fresh.buffers.some((buffer) => buffer.id === id));
            }
            for (const field of ['mutedNetworks', 'collapsedNetworks'] as const) {
              if (legacy[field]) legacy[field] = legacy[field].filter((id) => fresh.networks.some((network) => network.id === id));
            }
            if (!Object.keys(legacy).length) {
              if (owner === null || owner === String(userId)) clearLegacySettings();
              return;
            }
            try { localStorage.setItem('lingo-legacy-settings-owner', String(userId)); } catch { /* Storage may be disabled. */ }
            if (await updateSettings(legacy) && generation === settingsGeneration.current) clearLegacySettings();
          };
          try {
            if (navigator.locks) await navigator.locks.request(`lingo-settings-migration-${userId}`, migrate);
            else await migrate();
          } catch (error) {
            if (generation === settingsGeneration.current) fail(error);
          }
        })();
      }
    }
    setUser(data.user);
    updateUnread((current) => {
      const next: Record<number, BufferUnread> = {};
      for (const buffer of data.buffers) {
        const snapshot = data.unread[buffer.id] ?? { messages: 0, mentions: 0, lastReadId: 0 };
        const previous = current[buffer.id];
        if (previous && previous.lastReadId > snapshot.lastReadId) {
          next[buffer.id] = previous;
          continue;
        }
        const known = knownUnread(buffer.id, snapshot.lastReadId);
        next[buffer.id] = {
          lastReadId: snapshot.lastReadId,
          messages: Math.max(snapshot.messages, known.messages,
            previous?.lastReadId === snapshot.lastReadId ? previous.messages : 0),
          mentions: Math.max(snapshot.mentions, known.mentions,
            previous?.lastReadId === snapshot.lastReadId ? previous.mentions : 0),
        };
      }
      return next;
    });
    setNetworks((current) => data.networks.map((network) => {
      const previous = current.find((item) => item.id === network.id);
      return previous && JSON.stringify(previous) === JSON.stringify(network) ? previous : network;
    }));
    setBuffers(data.buffers);
    setStatuses(data.statuses);
    setIgnores(data.ignores);
    setSelectedId((current) => {
      if (current !== null && data.buffers.some((buffer) => buffer.id === current && !settingsRef.current.hiddenBuffers.includes(buffer.id))) return current;
      return (data.buffers.find((buffer) => buffer.kind === 'server')
        ?? data.buffers.find((buffer) => !settingsRef.current.hiddenBuffers.includes(buffer.id)))?.id ?? null;
    });
    return data;
  }, [applyServerSettings, fail, knownUnread, resetSyncedSettings, updateSettings, updateUnread]);
  const sendRead = useCallback(() => {
    readTimer.current = null;
    const pending = readPending.current;
    if (!pending || readInFlight.current) return;
    const snapshot = viewRef.current;
    if (!readVisibleRef.current || document.visibilityState !== 'visible'
      || selectedRef.current !== pending.bufferId || snapshot.bufferId !== pending.bufferId
      || snapshot.loading || jumpRef.current || !readBottomRef.current?.atBottom
      || readBottomRef.current.bufferId !== pending.bufferId) {
      readPending.current = null;
      return;
    }
    const messageId = Math.min(pending.messageId, snapshot.messages.at(-1)?.id ?? 0);
    readPending.current = null;
    if (messageId <= (unreadRef.current[pending.bufferId]?.lastReadId ?? 0)) return;
    const accountId = userRef.current?.id;
    const generationAtSend = readGeneration.current;
    readInFlight.current = true;
    lastReadSentAt.current = Date.now();
    void api<{ lastReadId: number }>(`/api/buffers/${pending.bufferId}/read`, json('PUT', { messageId }))
      .then((result) => {
        if (generationAtSend !== readGeneration.current || accountId !== userRef.current?.id) return;
        if (advanceRead(pending.bufferId, result.lastReadId)) {
          void refreshBootstrap().catch(fail);
        }
      }).catch((error: unknown) => {
        if (generationAtSend === readGeneration.current) fail(error);
      }).finally(() => {
        if (generationAtSend !== readGeneration.current) return;
        readInFlight.current = false;
        if (readPending.current) {
          readTimer.current = window.setTimeout(sendRead, Math.max(0, 1000 - (Date.now() - lastReadSentAt.current)));
        }
      });
  }, [advanceRead, fail, refreshBootstrap]);
  const requestRead = useCallback(() => {
    const bufferId = selectedRef.current;
    const snapshot = viewRef.current;
    if (bufferId === null || !readVisibleRef.current || document.visibilityState !== 'visible'
      || snapshot.bufferId !== bufferId || snapshot.loading || jumpRef.current
      || readBottomRef.current?.bufferId !== bufferId || !readBottomRef.current.atBottom) return;
    const messageId = snapshot.messages.at(-1)?.id;
    if (messageId === undefined || messageId <= (unreadRef.current[bufferId]?.lastReadId ?? 0)) return;
    const pending = readPending.current;
    readPending.current = { bufferId, messageId: pending?.bufferId === bufferId ? Math.max(messageId, pending.messageId) : messageId };
    if (readTimer.current === null && !readInFlight.current) {
      readTimer.current = window.setTimeout(sendRead, Math.max(0, 1000 - (Date.now() - lastReadSentAt.current)));
    }
  }, [sendRead]);
  const onTranscriptBottom = useCallback((bufferId: number, atBottom: boolean) => {
    readBottomRef.current = { bufferId, atBottom };
    if (atBottom) requestRead();
    else if (readPending.current?.bufferId === bufferId) readPending.current = null;
  }, [requestRead]);
  const selectedUnread = selectedId === null ? undefined : unread[selectedId];
  // The divider stays where the buffer's marker was when unread lines first appeared during
  // this visit, so reading them (which advances the marker) does not remove it.
  useEffect(() => {
    setDivider((current) => {
      if (selectedId === null) return null;
      if (current?.bufferId === selectedId) return current;
      return selectedUnread?.messages ? { bufferId: selectedId, after: selectedUnread.lastReadId } : null;
    });
  }, [selectedId, selectedUnread]);

  /** Bootstraps the session; when signed out, asks the server whether the admin account still needs to be created. */
  const openSession = useCallback(async (signal?: AbortSignal) => {
    try {
      await refreshBootstrap(signal);
      if (!signal?.aborted) setAuth('ready');
      return;
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        setAuthMessage(errorText(error));
        setAuth('unavailable');
        return;
      }
    }
    try {
      const status = await api<SetupStatus>('/api/setup', { signal });
      if (!signal?.aborted) setAuth(status.required ? 'setup' : 'login');
    } catch (error) {
      if (signal?.aborted) return;
      setAuthMessage(errorText(error));
      setAuth('unavailable');
    }
  }, [refreshBootstrap]);

  useEffect(() => {
    const controller = new AbortController();
    void openSession(controller.signal);
    return () => controller.abort();
  }, [openSession]);
  useEffect(() => {
    applyAppearance(preferences);
    savePreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!drawerSidebar) setSidebarOpen(false);
  }, [drawerSidebar]);
  useEffect(() => {
    if (!drawerUsers) setUsersPanelOpen(false);
  }, [drawerUsers]);
  useEffect(() => {
    try {
      localStorage.setItem('lingo-channel-lists', JSON.stringify(channelListTabs));
    } catch { /* Storage may be disabled. */ }
  }, [channelListTabs]);

  async function authenticated() {
    await refreshBootstrap();
    setAuthMessage('');
    setAuth('ready');
  }

  async function logout() {
    try {
      await api<unknown>('/api/logout', { method: 'POST' });
      void forgetPush().catch(() => {});
      bootstrapRequest.current++;
      resetSyncedSettings();
      setAuth('login');
      setAuthMessage('');
      setRememberedUsername('');
      setUser(null);
      setNetworks([]);
      setBuffers([]);
      setStatuses({});
      setIgnores({});
      setSelectedId(null);
      setView({ bufferId: null, messages: [], hasMore: false, loading: false, error: '' });
      closePanels();
      setDialog(null);
      setMenu(null);
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
        setJoinTarget(null);
        setTopicEditing(false);
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
          if (expired !== undefined) {
            receivedMessageIds.current.delete(expired);
            recentMessages.current.delete(expired);
          }
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
          if (buffer?.kind === 'query') removeSettingId('hiddenBuffers', buffer.id);
          const network = networksRef.current.find((item) => item.id === event.message.networkId);
          const identity = network && event.message.nick
            ? displayIdentity(event.message, network.relayNicks, network.displayNames) : null;
          const names = ownNames(network, network && statusesRef.current[network.id]);
          const sender = identity?.mentionTarget ?? event.message.nick;
          const own = !!sender && names.some((name) => name.toLowerCase() === sender.toLowerCase());
          const inbound = !own && !!sender && !event.message.fromNetwork
            && (event.message.kind === 'privmsg' || event.message.kind === 'action' || event.message.kind === 'notice');
          const highlight = inbound && (event.message.highlight === true || buffer?.kind === 'query');
          if (!own) {
            recentMessages.current.set(event.message.id, { bufferId: event.message.bufferId, mention: highlight });
            updateUnread((current) => {
              const previous = current[event.message.bufferId] ?? { messages: 0, mentions: 0, lastReadId: 0 };
              if (event.message.id <= previous.lastReadId) return current;
              return { ...current, [event.message.bufferId]: {
                ...previous, messages: previous.messages + 1, mentions: previous.mentions + Number(highlight),
              } };
            });
          }
          const muted = settingsRef.current.mutedBuffers.includes(event.message.bufferId)
            || (!!buffer && settingsRef.current.mutedNetworks.includes(buffer.networkId));
          if (!muted && identity && highlight) {
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
                playChime(audioContext.current ??= new AudioContext());
              } catch { /* AudioContext may be unavailable. */ }
            }
          }
          if (!buffer) {
            void refreshBootstrap(controller.signal).then((data) => {
              if (controller.signal.aborted || !data.buffers.some((item) => item.id === event.message.bufferId && item.kind === 'query')) return;
              removeSettingId('hiddenBuffers', event.message.bufferId);
            }).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          }
          break;
        }
        case 'buffer':
          if (event.buffer.kind === 'query') removeSettingId('hiddenBuffers', event.buffer.id);
          setBuffers((current) => current.some((buffer) => buffer.id === event.buffer.id)
            ? current.map((buffer) => buffer.id === event.buffer.id ? event.buffer : buffer)
            : [...current, event.buffer]);
          break;
        case 'buffer_removed': {
          const remaining = buffersRef.current.filter((buffer) => buffer.id !== event.bufferId);
          setBuffers(remaining);
          setSelectedId((selected) => selected === event.bufferId ? (remaining[0]?.id ?? null) : selected);
          updateUnread((current) => { const next = { ...current }; delete next[event.bufferId]; return next; });
          for (const [id, entry] of recentMessages.current) {
            if (entry.bufferId === event.bufferId) recentMessages.current.delete(id);
          }
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
          const removed = new Set(buffersRef.current.filter((buffer) => buffer.networkId === event.networkId).map((buffer) => buffer.id));
          updateUnread((current) => {
            const next = { ...current };
            for (const id of removed) delete next[id];
            return next;
          });
          for (const [id, entry] of recentMessages.current) {
            if (removed.has(entry.bufferId)) recentMessages.current.delete(id);
          }
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
          updateUnread((current) => ({ ...current,
            [event.bufferId]: { messages: 0, mentions: 0, lastReadId: current[event.bufferId]?.lastReadId ?? 0 },
          }));
          for (const [id, entry] of recentMessages.current) {
            if (entry.bufferId === event.bufferId) recentMessages.current.delete(id);
          }
          void refreshBootstrap(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          break;
        case 'read':
          if (advanceRead(event.bufferId, event.lastReadId)) {
            void refreshBootstrap(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted) fail(error); });
          }
          break;
        case 'channel_list':
          setChannelLists((current) => ({ ...current, [event.status.networkId]: event.status }));
          break;
        case 'ignores':
          setIgnores((current) => ({ ...current, [event.networkId]: event.ignores }));
          break;
        case 'settings':
          if (event.userId !== userRef.current?.id) break;
          settingsRevision.current++;
          settingsEventRevision.current++;
          applyServerSettings(event.settings);
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
  }, [auth, advanceRead, applyServerSettings, fail, refreshBootstrap, updateUnread]);

  useEffect(() => {
    if (auth !== 'ready') return;
    const bufferId = selectedId;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    setOlderPending(false);
    readBottomRef.current = null;
    readPending.current = null;
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
    requestRead();
  }, [auth, selectedId, view, settingsTarget, searchOpen, globalSettingsOpen, channelListView, jump, requestRead]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestRead();
      else {
        clearReadTimer();
        readPending.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearReadTimer();
      readPending.current = null;
      readGeneration.current++;
      readInFlight.current = false;
    };
  }, [clearReadTimer, requestRead]);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++channelStateVersion.current;
    setTopicEditing(false);
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
    setTopicEditing(true);
  }, [channelDetails]);

  function selectBuffer(id: number) {
    removeSettingId('hiddenBuffers', id);
    setMenu(null);
    setChannelListView(null);
    setJump(null);
    setSelectedId(id);
    closePanels();
    setNotice('');
    readBottomRef.current = null;
    readPending.current = null;
    document.querySelector<HTMLInputElement>('.composer input')?.focus();
  }
  const selectBufferRef = useRef(selectBuffer);
  selectBufferRef.current = selectBuffer;
  const requestedBuffer = useRef(launchBuffer);
  useEffect(() => {
    if (auth !== 'ready' || requestedBuffer.current === null) return;
    const id = requestedBuffer.current;
    requestedBuffer.current = null;
    if (buffers.some((buffer) => buffer.id === id)) selectBufferRef.current(id);
  }, [auth, buffers]);
  useEffect(() => {
    if (auth !== 'ready' || !pushSupported()) return;
    void registerServiceWorker().then(() => syncPush())
      .catch(() => setNotice('Could not renew push notifications on this device.'));
    const openBuffer = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'open-buffer' ||
        !('bufferId' in data) || typeof data.bufferId !== 'number') return;
      const id = data.bufferId;
      if (buffersRef.current.some((buffer) => buffer.id === id)) selectBufferRef.current(id);
    };
    navigator.serviceWorker.addEventListener('message', openBuffer);
    return () => navigator.serviceWorker.removeEventListener('message', openBuffer);
  }, [auth]);

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

  /** Saves a display-name override for a nick; rejects with the error for the dialog to show. */
  async function renameNick(networkId: number, mentionTarget: string, displayName: string) {
    const network = networks.find((item) => item.id === networkId);
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
    try {
      await api<Network>(`/api/networks/${network.id}`, json('PATCH', input));
      await refreshBootstrap();
      setDialog(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) sessionExpired();
      throw error;
    }
  }

  function beginRename(networkId: number, mentionTarget: string) {
    const network = networks.find((item) => item.id === networkId);
    if (!network) return;
    const canonicalKey = mentionTarget.toLowerCase();
    const existing = Object.entries(network.displayNames)
      .find(([key]) => key.toLowerCase() === canonicalKey)?.[1] ?? '';
    setDialog({ kind: 'displayName', networkId, nick: canonicalKey, initial: existing });
  }

  /** Joins validated channel names; rejects with the error for the join form to show. */
  async function joinChannels(networkId: number, names: string[]) {
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
    for (const buffer of joined) rememberChannel(networkId, buffer.name);
    const joinedIds = joined.map((buffer) => buffer.id);
    const stillHidden = settingsRef.current.hiddenBuffers.filter((id) => !joinedIds.includes(id));
    if (stillHidden.length !== settingsRef.current.hiddenBuffers.length) updateSettings({ hiddenBuffers: stillHidden });
    removeSettingId('collapsedNetworks', networkId);
    await refreshBootstrap();
    setJoinTarget(null);
    if (joined.length) selectBuffer(joined[joined.length - 1].id);
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
      if (!settingsRef.current.hiddenBuffers.includes(buffer.id)) {
        updateSettings({ hiddenBuffers: [...settingsRef.current.hiddenBuffers, buffer.id] });
      }
      if (selectedRef.current === buffer.id) {
        setJump(null);
        setSelectedId((buffers.find((item) => item.networkId === buffer.networkId && item.kind === 'server')
          ?? buffers.find((item) => item.id !== buffer.id && !settingsRef.current.hiddenBuffers.includes(item.id)))?.id ?? null);
      }
      if (buffer.kind === 'channel') await refreshBootstrap();
    } catch (error) {
      fail(error);
    }
  }

  /** Sets the selected channel's topic; rejects with the error for the topic editor to show. */
  async function saveTopic(topic: string) {
    if (selectedChannelId === null || !channelJoined || !channelConnected) return;
    try {
      await api<{ ok: true }>(`/api/buffers/${selectedChannelId}/topic`, json('PATCH', { topic }));
      setTopicEditing(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) sessionExpired();
      throw error;
    }
  }

  function beginTopicEdit(buffer: ChatBuffer) {
    pendingTopicEdit.current = buffer.id;
    if (selectedId !== buffer.id || channelListView !== null || settingsTarget !== null || searchOpen || globalSettingsOpen) {
      selectBuffer(buffer.id);
    }
    // Already showing this channel: the details effect will not fire again, so apply now.
    if (selectedId === buffer.id && channelDetails?.bufferId === buffer.id && channelDetails.state) {
      pendingTopicEdit.current = null;
      setTopicEditing(true);
    }
  }

  function openChannelList(networkId: number, refresh: boolean) {
    setChannelListTabs((current) => current.includes(networkId) ? current : [...current, networkId]);
    removeSettingId('collapsedNetworks', networkId);
    setChannelListView(networkId);
    closePanels();
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
      removeSettingId('collapsedNetworks', networkId);
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

  function menuItems(subject: MenuSubject): { label: string; items: MenuItem[] } | null {
    if (subject.kind === 'network') {
      const network = networks.find((item) => item.id === subject.networkId);
      if (!network) return null;
      const server = buffers.find((buffer) => buffer.networkId === network.id && buffer.kind === 'server');
      const offline = (statuses[network.id]?.state ?? 'disconnected') === 'disconnected';
      return { label: `${network.name} actions`, items: [
        { label: network.name, heading: true, onSelect: server ? () => selectBuffer(server.id) : undefined },
        { label: 'Join a channel…', onSelect: () => {
          removeSettingId('collapsedNetworks', network.id);
          setJoinTarget(network.id);
          if (drawerSidebar) setSidebarOpen(true);
        } },
        { label: 'List all channels', disabled: offline, onSelect: () => openChannelList(network.id, true) },
        { label: 'Ignored users…', onSelect: () => setDialog({ kind: 'ignores', networkId: network.id }) },
        { label: syncedSettings.mutedNetworks.includes(network.id) ? 'Unmute network' : 'Mute network',
          onSelect: () => toggleSettingId('mutedNetworks', network.id) },
        { label: 'Network settings…', onSelect: () => openNetworkSettings(network.id) },
        offline
          ? { label: 'Connect', onSelect: () => void setNetworkConnected(network.id, true) }
          : { label: 'Disconnect', onSelect: () => void setNetworkConnected(network.id, false) },
        { label: 'Remove network', danger: true, onSelect: () => void removeNetwork(network) },
      ] };
    }
    if (subject.kind === 'user') {
      const ignored = (ignores[subject.networkId] ?? []).some((nick) => nick.toLowerCase() === subject.nick.toLowerCase());
      return { label: `${subject.nick} actions`, items: [
        { label: subject.nick, heading: true },
        { label: 'Direct message', onSelect: () => void openQuery(subject.networkId, subject.nick) },
        { label: 'User info', onSelect: () => setDialog({ kind: 'whois', networkId: subject.networkId, nick: subject.nick }) },
        { label: 'Set display name…', onSelect: () => beginRename(subject.networkId, subject.nick) },
        { label: ignored ? 'Unignore user' : 'Ignore user', danger: !ignored,
          onSelect: () => void setIgnored(subject.networkId, subject.nick, !ignored) },
      ] };
    }
    const buffer = buffers.find((item) => item.id === subject.bufferId);
    if (!buffer || buffer.kind === 'server') return null;
    const network = networks.find((item) => item.id === buffer.networkId);
    const muteLabel = `${syncedSettings.mutedBuffers.includes(buffer.id) ? 'Unmute' : 'Mute'} ${buffer.kind === 'channel' ? 'channel' : 'conversation'}`;
    if (buffer.kind === 'query') {
      return { label: `${buffer.name} actions`, items: [
        { label: buffer.name, heading: true, onSelect: () => selectBuffer(buffer.id) },
        { label: 'User info', onSelect: () => setDialog({ kind: 'whois', networkId: buffer.networkId, nick: buffer.name }) },
        { label: 'Set display name…', onSelect: () => beginRename(buffer.networkId, buffer.name) },
        { label: muteLabel, onSelect: () => toggleSettingId('mutedBuffers', buffer.id) },
        { label: 'Clear history…', onSelect: () => void clearHistory(buffer) },
        { label: 'Close conversation', onSelect: () => void closeBuffer(buffer) },
      ] };
    }
    const joined = isJoined(network, buffer.name);
    const live = joined && statuses[buffer.networkId]?.state === 'connected';
    return { label: `${buffer.name} actions`, items: [
      { label: buffer.name, heading: true, onSelect: () => selectBuffer(buffer.id) },
      { label: 'Edit topic', disabled: !live, onSelect: () => beginTopicEdit(buffer) },
      { label: 'Ban list…', disabled: !live, onSelect: () => setDialog({ kind: 'bans', bufferId: buffer.id }) },
      { label: muteLabel, onSelect: () => toggleSettingId('mutedBuffers', buffer.id) },
      { label: 'Clear history…', onSelect: () => void clearHistory(buffer) },
      joined
        ? { label: 'Leave channel', danger: true, onSelect: () => void part(buffer) }
        : { label: 'Rejoin channel', onSelect: () => void joinChannel(buffer.networkId, buffer.name) },
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
    removeSettingId('hiddenBuffers', message.bufferId);
    removeSettingId('collapsedNetworks', message.networkId);
    setMenu(null);
    setChannelListView(null);
    setJump({ bufferId: message.bufferId, messageId: message.id, serial: ++jumpSerial.current });
    setSelectedId(message.bufferId);
    closePanels();
    setNotice('');
  }

  const sidebarControl = useMemo<SidebarControl>(() => ({
    hidden: drawerSidebar ? !sidebarOpen : preferences.sidebarCollapsed,
    drawer: drawerSidebar,
    toggle: () => {
      if (drawerSidebar) setSidebarOpen((open) => !open);
      else setPreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
    },
  }), [drawerSidebar, sidebarOpen, preferences.sidebarCollapsed]);

  if (auth !== 'ready') {
    return <AuthScreen mode={auth} message={authMessage} initialUsername={rememberedUsername}
      initialSetupToken={initialSetupToken} theme={preferences.theme}
      onThemeChange={(theme) => setPreferences((current) => ({ ...current, theme }))}
      onModeChange={(mode, message = '') => { setAuthMessage(message); setAuth(mode); }}
      onAuthenticated={authenticated}
      onRetry={() => { setAuthMessage(''); setAuth('checking'); void openSession(); }} />;
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
  const menuSpec = menu && menuItems(menu.subject);
  const dialogNetwork = dialog && dialog.kind !== 'bans' ? networks.find((network) => network.id === dialog.networkId) : undefined;
  const dialogBuffer = dialog?.kind === 'bans' ? buffers.find((buffer) => buffer.id === dialog.bufferId) : undefined;
  const usersVisible = drawerUsers ? usersPanelOpen : !preferences.userListHidden;
  const headerSubject: MenuSubject | null = selected
    ? selected.kind === 'server' ? { kind: 'network', networkId: selected.networkId } : { kind: 'buffer', bufferId: selected.id }
    : null;
  const jumped = !!selected && jump?.bufferId === selected.id;

  return <SidebarContext.Provider value={sidebarControl}>
    <div className={`app-shell${preferences.sidebarCollapsed && !drawerSidebar ? ' is-sidebar-collapsed' : ''}`}>
      {drawerSidebar && sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close networks"
        onClick={() => setSidebarOpen(false)} />}
      <Sidebar sidebarRef={sidebarRef} drawer={drawerSidebar} open={sidebarOpen}
        collapsed={!drawerSidebar && preferences.sidebarCollapsed} connection={connection} user={user}
        networks={networks} buffers={buffers} statuses={statuses} unread={unread} settings={syncedSettings}
        activeBufferId={showingConversation ? selectedId : null}
        activeChannelList={settingsTarget === null && !searchOpen && !globalSettingsOpen ? channelListView : null}
        channelListTabs={channelListTabs} channelLists={channelLists} joinTarget={joinTarget} rejoining={joining}
        searchOpen={searchOpen} settingsOpen={globalSettingsOpen} menuOpenFor={menu?.subject ?? null}
        onSelectBuffer={selectBuffer} onToggleNetwork={(id) => toggleSettingId('collapsedNetworks', id)}
        onJoinTargetChange={(id) => { setJoinTarget(id); if (id !== null) removeSettingId('collapsedNetworks', id); }}
        onJoinChannels={joinChannels} onRejoin={(buffer) => void joinChannel(buffer.networkId, buffer.name)}
        onCloseBuffer={(buffer) => void closeBuffer(buffer)} onOpenChannelList={(id) => openChannelList(id, false)}
        onCloseChannelList={closeChannelList} onMenu={openMenu} onAddNetwork={() => openNetworkSettings('new')}
        onHome={() => {
          closePanels();
          setMenu(null);
          setChannelListView(null);
        }}
        onSearch={openSearch}
        onSettings={() => {
          const open = !globalSettingsOpen;
          closePanels();
          setGlobalSettingsOpen(open);
        }}
        onSignOut={() => void logout()} onHide={toggleSidebar} />
      {!drawerSidebar && !preferences.sidebarCollapsed && <SidebarResizer sidebarRef={sidebarRef} width={preferences.sidebarWidth}
        onResize={(width) => setPreferences((current) => ({ ...current, sidebarWidth: width }))} />}
      <main className="main-pane">
        {connection === 'offline' && <div className="connection-banner" role="status">
          <span className="status-dot status-reconnecting" aria-hidden="true" />
          Connection to Lingo lost. Reconnecting…
        </div>}
        {notice && <div className="toast" role="alert">
          <span>{notice}</span>
          <button className="icon-button icon-button-small" type="button" aria-label="Dismiss" onClick={() => setNotice('')}>
            <Icon name="x" />
          </button>
        </div>}
        {settingsTarget !== null ? <NetworkSettings key={settingsTarget} network={settingsNetwork}
          onSave={saveNetwork} onDelete={deleteNetwork} onClose={() => setSettingsTarget(null)} />
        : searchOpen ? <SearchPanel networks={networks} buffers={buffers} initialBufferId={selectedId ?? undefined}
          onClose={() => setSearchOpen(false)} onJump={jumpTo} />
        : globalSettingsOpen && user ? <GlobalSettings user={user} preferences={preferences}
          settings={syncedSettings} onSettingsChange={updateSettings}
          onChange={setPreferences} onEnableNotifications={enableNotifications} onSoundChange={changeSound}
          onClose={() => setGlobalSettingsOpen(false)} onUnauthorized={() => {
            sessionExpired();
            setGlobalSettingsOpen(false);
          }} />
        : channelListNetwork ? <ChannelListPanel key={channelListNetwork.id} network={channelListNetwork}
          status={channelLists[channelListNetwork.id]}
          connected={statuses[channelListNetwork.id]?.state === 'connected'}
          isJoined={(name) => isJoined(channelListNetwork, name)}
          onJoin={(name) => void joinChannel(channelListNetwork.id, name)}
          onRefresh={() => void refreshChannelList(channelListNetwork.id)}
          onClose={() => closeChannelList(channelListNetwork.id)} onUnauthorized={sessionExpired} />
        : selected && activeNetwork ? <>
          <ConversationHeader key={selected.id} buffer={selected} network={activeNetwork}
            topic={selectedDetails?.state ? selectedDetails.state.topic : null}
            userCount={selectedDetails?.state?.users.length ?? null}
            canEditTopic={selected.kind === 'channel' && selectedJoined && selectedState === 'connected'}
            editingTopic={topicEditing} usersOpen={usersVisible}
            menuOpen={!!menu && !!headerSubject && sameSubject(menu.subject, headerSubject)}
            onEditTopic={() => beginTopicEdit(selected)} onCancelTopic={() => setTopicEditing(false)} onSaveTopic={saveTopic}
            onToggleUsers={toggleUsers} onSearch={openSearch}
            onMenu={(event) => headerSubject && openMenu(event, headerSubject)} />
          <Transcript buffer={selected} network={activeNetwork} messages={messages}
            ownNames={ownNames(activeNetwork, statuses[selected.networkId])}
            loading={!showingView || view.loading} hasMore={showingView && view.hasMore} olderPending={olderPending}
            error={showingView ? view.error : ''} jumpId={jumped ? jump!.messageId : null}
            onLoadOlder={loadOlder} onRetry={() => setReloadSerial((current) => current + 1)}
            onNickMenu={(nick, x, y) => setMenu({ subject: { kind: 'user', networkId: selected.networkId, nick }, x, y })}
            onBackToLatest={() => setJump(null)}
            preferences={preferences} highlights={syncedSettings.highlights} theme={preferences.theme}
            dividerAfter={divider?.bufferId === selected.id ? divider.after : null}
            onBottomChange={onTranscriptBottom} />
          {jumped && <div className="conversation-bar" role="status">
            <Icon name="search" />
            <span>Viewing a search result in older history.</span>
            <button className="button button-small" type="button" onClick={() => setJump(null)}>Back to latest</button>
          </div>}
          {!selectedJoined && <div className="conversation-bar is-warning" role="status">
            <Icon name="info" />
            <span>You are not in {selected.name}. Its history is kept.</span>
            <button className="button button-primary button-small" type="button" disabled={joining}
              onClick={() => void joinChannel(selected.networkId, selected.name)}>{joining ? 'Joining…' : 'Rejoin'}</button>
          </div>}
          <MentionComposer buffer={selected} network={activeNetwork} messages={messages}
            ownNames={ownNames(activeNetwork, statuses[selected.networkId])} disabled={!selectedJoined || sending}
            knownChannels={buffers.filter((buffer) => buffer.networkId === selected.networkId && buffer.kind === 'channel')
              .map((buffer) => buffer.name)}
            channelListUpdatedAt={channelLists[selected.networkId]?.updatedAt ?? null}
            onSend={sendMessage} onError={(error) => setNotice(errorText(error))} autocomplete={preferences.autocomplete} />
        </> : <>
          <PaneHeader title="lingo" />
          <div className="welcome">
            <div className="welcome__mark" aria-hidden="true">&gt;_</div>
            <h2>{networks.length ? 'Pick a conversation' : 'Welcome to Lingo'}</h2>
            <p>{networks.length
              ? 'Choose a channel from the sidebar, or join a new one from a network’s menu.'
              : 'Add an IRC network to keep your channels and their history in one place, across all your devices.'}</p>
            {!networks.length && <button className="button button-primary" type="button" onClick={() => openNetworkSettings('new')}>
              <Icon name="plus" />Add your first network
            </button>}
          </div>
        </>}
      </main>
      {showingConversation && selected.kind === 'channel' && (drawerUsers || !preferences.userListHidden) && <>
        {drawerUsers && usersPanelOpen && <button className="user-panel-scrim" type="button" aria-label="Close users"
          onClick={() => setUsersPanelOpen(false)} />}
        <UserList key={selected.id} channel={selected.name} open={usersVisible} onClose={toggleUsers}
          nickTheme={preferences.coloredNicknames ? preferences.theme : null}
          users={selectedDetails?.state?.users ?? null}
          message={!selectedJoined ? 'Members are unavailable while you are not in the channel.'
            : !channelConnected ? `Members are unavailable while ${selectedState}.`
              : selectedDetails?.error || 'Loading members…'}
          onUserMenu={(nick, x, y) => setMenu({ subject: { kind: 'user', networkId: selected.networkId, nick }, x, y })} />
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
    {dialog?.kind === 'displayName' && dialogNetwork && <DisplayNameDialog network={dialogNetwork} nick={dialog.nick}
      initial={dialog.initial} onSave={(name) => renameNick(dialogNetwork.id, dialog.nick, name)}
      onClose={() => setDialog(null)} />}
  </SidebarContext.Provider>;
}
