import { useState, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type {
  AccountUser, BufferUnread, ChannelListStatus, ChatBuffer, Network, NetworkStatus, SyncedSettings,
} from '../shared/contracts';
import { errorText } from './api';
import { isJoined, sidebarOrder } from './chat';
import type { MenuSubject } from './ContextMenu';
import Icon from './Icon';
import { clampSidebarWidth, maxSidebarWidth, minSidebarWidth } from './preferences';
import { commandKey } from './shortcuts';

type SidebarProps = {
  sidebarRef: RefObject<HTMLElement | null>;
  /** Narrow layout: the sidebar is an off-canvas drawer. */
  drawer: boolean;
  open: boolean;
  collapsed: boolean;
  connection: 'connecting' | 'live' | 'offline';
  user: AccountUser | null;
  networks: Network[];
  buffers: ChatBuffer[];
  statuses: Record<number, NetworkStatus>;
  unread: Record<number, BufferUnread>;
  settings: SyncedSettings;
  /** The buffer shown in the conversation view, or null when a panel covers it. */
  activeBufferId: number | null;
  activeChannelList: number | null;
  channelListTabs: number[];
  channelLists: Record<number, ChannelListStatus>;
  joinTarget: number | null;
  rejoining: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  menuOpenFor: MenuSubject | null;
  onSelectBuffer: (id: number) => void;
  onToggleNetwork: (networkId: number) => void;
  onJoinTargetChange: (networkId: number | null) => void;
  /** Joins validated channel names; rejects with a user-facing error. */
  onJoinChannels: (networkId: number, names: string[]) => Promise<void>;
  onRejoin: (buffer: ChatBuffer) => void;
  onCloseBuffer: (buffer: ChatBuffer) => void;
  onOpenChannelList: (networkId: number) => void;
  onCloseChannelList: (networkId: number) => void;
  onMenu: (event: MouseEvent<HTMLElement>, subject: MenuSubject) => void;
  /** Leaves any open panel (settings, search, channel list) for the selected conversation. */
  onHome: () => void;
  onAddNetwork: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onHide: () => void;
};

const connectionLabel = { connecting: 'Connecting…', live: 'Live', offline: 'Reconnecting…' } as const;

function sameSubject(left: MenuSubject | null, right: MenuSubject): boolean {
  return !!left && JSON.stringify(left) === JSON.stringify(right);
}

/** Mentions keep a count badge; other unread messages only brighten the row, so screen readers get a plain "unread" note. */
function UnreadBadges({ unread, muted }: { unread: BufferUnread | undefined; muted: boolean }) {
  if (muted || !unread) return null;
  if (unread.mentions) return <span className="badge badge-mention" aria-label={`${unread.mentions} unread mentions`}>{unread.mentions}</span>;
  if (unread.messages) return <span className="sr-only">, unread</span>;
  return null;
}

function JoinForm({ network, onJoin, onCancel }: {
  network: Network;
  onJoin: (names: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // Bare names get the common '#' prefix, so "bun, #rust" joins #bun and #rust.
    const names = value.trim().split(/[,\s]+/).filter(Boolean).map((name) => /^[#&+!]/.test(name) ? name : `#${name}`);
    if (!names.length || names.length > 20 || names.some((name) => name.length > 100
      || !/^[#&+!][^\s,\x00-\x1f\x7f]+$/.test(name))
      || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      setError('Enter up to 20 distinct channel names, separated by commas or spaces.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await onJoin(names);
    } catch (joinError) {
      setError(errorText(joinError));
      setPending(false);
    }
  }

  return <form className="sidebar-join" onSubmit={(event) => void submit(event)}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}>
    <label className="sr-only" htmlFor={`join-${network.id}`}>Channels to join on {network.name}</label>
    <div className="sidebar-join__field">
      <Icon name="hash" />
      <input id={`join-${network.id}`} autoFocus value={value} placeholder="channel, #another" autoComplete="off"
        spellCheck={false} disabled={pending} aria-invalid={!!error}
        aria-describedby={error ? `join-error-${network.id}` : undefined}
        onChange={(event) => { setValue(event.target.value); setError(''); }} />
      <button className="button button-primary button-small" type="submit" disabled={pending || !value.trim()}>
        {pending ? 'Joining…' : 'Join'}
      </button>
    </div>
    {error && <p className="error-text" id={`join-error-${network.id}`} role="alert">{error}</p>}
  </form>;
}

/** Networks, their buffers, and the account controls. */
export default function Sidebar(props: SidebarProps) {
  const {
    sidebarRef, drawer, open, collapsed, connection, user, networks, buffers, statuses, unread, settings,
    activeBufferId, activeChannelList, channelListTabs, channelLists, joinTarget, rejoining, searchOpen, settingsOpen,
    menuOpenFor, onSelectBuffer, onToggleNetwork, onJoinTargetChange, onJoinChannels, onRejoin, onCloseBuffer,
    onOpenChannelList, onCloseChannelList, onMenu, onHome, onAddNetwork, onSearch, onSettings, onSignOut, onHide,
  } = props;

  /** The ⋯ buttons toggle their menu; stopping pointerdown keeps the open menu from closing itself first. */
  function menuButton(label: string, subject: MenuSubject, className = '') {
    const expanded = sameSubject(menuOpenFor, subject);
    return <button type="button" className={`icon-button icon-button-small ${className}`} aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={expanded}
      onPointerDown={(event) => { if (expanded) event.stopPropagation(); }}
      onClick={(event) => onMenu(event, subject)}><Icon name="more" /></button>;
  }

  return <aside id="networks-sidebar" ref={sidebarRef} aria-label="Networks and buffers"
    className={`sidebar${drawer ? ' sidebar-drawer' : ''}${open ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
    <div className="sidebar__top">
      <div className="sidebar__brand">
        <button type="button" className="sidebar__home" onClick={onHome} aria-label="Back to conversation" title="Back to conversation">
          <span className="sidebar__logo" aria-hidden="true">&gt;_</span>
          <span className="sidebar__name" aria-hidden="true">lingo</span>
        </button>
        <span className={`status-dot status-${connection}`} role="status" aria-label={`Live updates: ${connectionLabel[connection]}`}
          title={`Live updates: ${connectionLabel[connection]}`} />
      </div>
      <button type="button" className="icon-button" aria-label="Hide networks" title="Hide networks" aria-controls="networks-sidebar"
        aria-expanded onClick={onHide}><Icon name={drawer ? 'x' : 'sidebar'} /></button>
    </div>
    <button type="button" className={`sidebar__search${searchOpen ? ' is-active' : ''}`} onClick={onSearch}>
      <Icon name="search" /><span>Search</span><kbd>{commandKey} F</kbd>
    </button>
    <nav className="sidebar__networks" aria-label="Networks">
      {networks.length === 0 && <div className="sidebar__empty">
        <p>No networks yet.</p>
        <button className="button button-primary button-small" type="button" onClick={onAddNetwork}>
          <Icon name="plus" />Add a network
        </button>
      </div>}
      {networks.map((network) => {
        const status = statuses[network.id];
        const state = status?.state ?? 'disconnected';
        const server = buffers.find((buffer) => buffer.networkId === network.id && buffer.kind === 'server');
        const networkBuffers = buffers.filter((buffer) => buffer.networkId === network.id
          && buffer.kind !== 'server' && !settings.hiddenBuffers.includes(buffer.id)).sort(sidebarOrder);
        const networkCollapsed = settings.collapsedNetworks.includes(network.id);
        const networkMuted = settings.mutedNetworks.includes(network.id);
        const serverActive = !!server && activeBufferId === server.id;
        const serverUnread = !!server && !networkMuted && !settings.mutedBuffers.includes(server.id) && !!unread[server.id]?.messages;
        return <section className={`sidebar-network${networkMuted ? ' is-muted' : ''}`} key={network.id}
          aria-label={`${network.name} network`}>
          <div className={`sidebar-network__row${serverActive ? ' is-active' : ''}${serverUnread ? ' is-unread' : ''}`}
            onContextMenu={(event) => onMenu(event, { kind: 'network', networkId: network.id })}>
            <button className="sidebar-network__chevron" type="button" aria-expanded={!networkCollapsed}
              aria-controls={`network-buffers-${network.id}`}
              aria-label={`${networkCollapsed ? 'Expand' : 'Collapse'} ${network.name} channels`}
              onClick={() => onToggleNetwork(network.id)}>
              <Icon name="chevronRight" />
            </button>
            <button className="sidebar-network__name" type="button" disabled={!server}
              aria-current={serverActive ? 'page' : undefined} title={`${network.name} — ${status?.error || state}`}
              onClick={() => server && onSelectBuffer(server.id)}>
              <span className={`status-dot status-${state}`} aria-label={state} />
              <span className="sidebar-network__label">{network.name}</span>
              {networkMuted && <Icon name="bellOff" className="sidebar-muted-icon" />}
              {server && <UnreadBadges unread={unread[server.id]} muted={networkMuted || settings.mutedBuffers.includes(server.id)} />}
            </button>
            <span className="sidebar-network__actions">
              <button className="icon-button icon-button-small" type="button" aria-label={`Join channel on ${network.name}`}
                title="Join channel" aria-expanded={joinTarget === network.id}
                onClick={() => onJoinTargetChange(joinTarget === network.id ? null : network.id)}><Icon name="plus" /></button>
              {menuButton(`${network.name} actions`, { kind: 'network', networkId: network.id })}
            </span>
          </div>
          {!networkCollapsed && status?.error && <p className="sidebar-network__error" title={status.error}>{status.error}</p>}
          {joinTarget === network.id && <JoinForm key={network.id} network={network}
            onJoin={(names) => onJoinChannels(network.id, names)} onCancel={() => onJoinTargetChange(null)} />}
          {!networkCollapsed && <ul className="sidebar-buffers" id={`network-buffers-${network.id}`}
            aria-label={`${network.name} buffers`}>
            {channelListTabs.includes(network.id) && <li className={`sidebar-buffer${activeChannelList === network.id ? ' is-active' : ''}`}>
              <button type="button" className="sidebar-buffer__main" aria-current={activeChannelList === network.id ? 'page' : undefined}
                onClick={() => onOpenChannelList(network.id)}>
                <Icon name="list" className="sidebar-buffer__icon" />
                <span className="sidebar-buffer__name">Channel list</span>
                {channelLists[network.id]?.state === 'loading' && <span className="sidebar-spinner" aria-label="Loading" />}
              </button>
              <button type="button" className="icon-button icon-button-small sidebar-buffer__close"
                aria-label={`Close channel list for ${network.name}`} title="Close channel list"
                onClick={() => onCloseChannelList(network.id)}><Icon name="x" /></button>
            </li>}
            {networkBuffers.map((buffer) => {
              const parted = buffer.kind === 'channel' && !isJoined(network, buffer.name);
              const muted = networkMuted || settings.mutedBuffers.includes(buffer.id);
              const active = activeBufferId === buffer.id;
              const counts = unread[buffer.id];
              const hasUnread = !muted && !!counts?.messages;
              return <li key={buffer.id}
                className={['sidebar-buffer', active && 'is-active', hasUnread && 'is-unread', muted && 'is-muted',
                  parted && 'is-parted'].filter(Boolean).join(' ')}
                onContextMenu={(event) => onMenu(event, { kind: 'buffer', bufferId: buffer.id })}>
                <button type="button" className="sidebar-buffer__main" aria-current={active ? 'page' : undefined}
                  title={parted ? `${buffer.name} (not joined)` : buffer.name} onClick={() => onSelectBuffer(buffer.id)}>
                  <Icon name={buffer.kind === 'channel' ? 'hash' : 'at'} className="sidebar-buffer__icon" />
                  <span className="sidebar-buffer__name">{buffer.kind === 'channel' ? buffer.name.replace(/^#/, '') : buffer.name}</span>
                  {muted && <Icon name="bellOff" className="sidebar-muted-icon" />}
                  <UnreadBadges unread={counts} muted={muted} />
                </button>
                {parted && <button type="button" className="icon-button icon-button-small sidebar-buffer__rejoin" disabled={rejoining}
                  aria-label={`Rejoin ${buffer.name} on ${network.name}`} title={`Rejoin ${buffer.name}`}
                  onClick={() => onRejoin(buffer)}><Icon name="rotate" /></button>}
                <button type="button" className="icon-button icon-button-small sidebar-buffer__close"
                  aria-label={`Close ${buffer.name} on ${network.name}`} title={`Close ${buffer.name}`}
                  onClick={() => onCloseBuffer(buffer)}><Icon name="x" /></button>
              </li>;
            })}
          </ul>}
        </section>;
      })}
      {networks.length > 0 && <button type="button" className="sidebar-add-network" onClick={onAddNetwork}>
        <Icon name="plus" /><span>Add network</span>
      </button>}
    </nav>
    <div className="sidebar__footer">
      <span className="sidebar__avatar" aria-hidden="true">{user?.username.slice(0, 1).toUpperCase()}</span>
      <span className="sidebar__user" title={user ? `Signed in as ${user.username}` : undefined}>
        <strong>{user?.username}</strong>
        {user?.isAdmin && <span>Admin</span>}
      </span>
      <button type="button" className="icon-button" aria-label="Settings" title="Settings" aria-pressed={settingsOpen}
        onClick={onSettings}><Icon name="settings" /></button>
      <button type="button" className="icon-button" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
        <Icon name="logOut" />
      </button>
    </div>
  </aside>;
}

/** Drag or arrow keys resize the sidebar; dragging writes the CSS variable directly and commits once on release. */
export function SidebarResizer({ sidebarRef, width, onResize }: {
  sidebarRef: RefObject<HTMLElement | null>;
  width: number | null;
  onResize: (width: number | null) => void;
}) {
  function startResize(event: PointerEvent<HTMLDivElement>) {
    const sidebar = sidebarRef.current;
    if (event.button !== 0 || !sidebar) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const root = document.documentElement;
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    let next = clampSidebarWidth(startWidth);
    const move = (moveEvent: globalThis.PointerEvent) => {
      next = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      root.style.setProperty('--sidebar-width', `${next}px`);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      root.classList.remove('sidebar-resizing');
      onResize(next);
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    root.classList.add('sidebar-resizing');
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    const current = sidebarRef.current?.getBoundingClientRect().width;
    if (current === undefined) return;
    const next = event.key === 'ArrowLeft' ? current - 16 : event.key === 'ArrowRight' ? current + 16
      : event.key === 'Home' ? minSidebarWidth : event.key === 'End' ? maxSidebarWidth : null;
    if (next === null) return;
    event.preventDefault();
    onResize(clampSidebarWidth(next));
  }

  return <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize networks"
    aria-controls="networks-sidebar" tabIndex={0} aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth}
    aria-valuenow={width ?? undefined} title="Drag to resize · double-click to reset"
    onPointerDown={startResize} onKeyDown={resizeWithKeys} onDoubleClick={() => onResize(null)} />;
}
