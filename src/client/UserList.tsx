import { useMemo, useState, type MouseEvent } from 'react';
import type { ChannelUser } from '../shared/contracts';

type UserListProps = {
  channel: string;
  /** `null` while the roster is unavailable; `message` explains why. */
  users: ChannelUser[] | null;
  message: string;
  open: boolean;
  onClose: () => void;
  onUserMenu: (nick: string, x: number, y: number) => void;
};

export default function UserList({ channel, users, message, open, onClose, onUserMenu }: UserListProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return !users || !needle ? users : users.filter((user) => user.nick.toLocaleLowerCase().includes(needle));
  }, [users, query]);

  function openMenu(event: MouseEvent<HTMLButtonElement>, nick: string) {
    event.preventDefault();
    // Keyboard-invoked context menus report no pointer position.
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX !== 0 || event.clientY !== 0;
    onUserMenu(nick, pointer ? event.clientX : rect.left, pointer ? event.clientY : rect.bottom);
  }

  return <aside className={`user-panel${open ? ' user-panel-open' : ''}`} aria-label={`${channel} users`}>
    <div className="user-panel__header">
      <span>USERS{users ? ` · ${users.length}` : ''}</span>
      <button className="icon-button user-panel__close" type="button" aria-label="Close users" onClick={onClose}>×</button>
    </div>
    <div className="user-panel__search">
      <label className="sr-only" htmlFor="user-search">Search users in {channel}</label>
      <input id="user-search" type="search" value={query} placeholder="Search users…" autoComplete="off"
        disabled={!users} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {!filtered ? <p className="user-panel__status" role="status">{message}</p>
      : !filtered.length ? <p className="user-panel__status">{query ? 'No matching users' : 'No users'}</p>
        : <ul className="user-panel__list">
          {filtered.map((user) => <li key={user.nick}>
            <button type="button" className="user-entry" title={`${user.nick} — click for actions`}
              onContextMenu={(event) => openMenu(event, user.nick)}
              onClick={(event) => openMenu(event, user.nick)}>
              <span className="channel-user-prefix" data-prefix={user.prefix}>{user.prefix}</span>
              <span className="user-entry__nick">{user.nick}</span>
            </button>
          </li>)}
        </ul>}
    {filtered && query && users && filtered.length !== users.length
      && <p className="user-panel__footer">{filtered.length} of {users.length} shown</p>}
  </aside>;
}
