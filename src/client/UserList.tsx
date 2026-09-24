import { useMemo, useState, type MouseEvent } from 'react';
import type { ChannelUser } from '../shared/contracts';
import Icon from './Icon';
import { nicknameColor } from './nickColor';
import type { Theme } from './ThemePicker';

type UserListProps = {
  channel: string;
  /** `null` while the roster is unavailable; `message` explains why. */
  users: ChannelUser[] | null;
  message: string;
  open: boolean;
  /** Color nicks like the transcript; `null` leaves them uncolored. */
  nickTheme: Theme | null;
  onClose: () => void;
  onUserMenu: (nick: string, x: number, y: number) => void;
};

const roleNames: Record<string, string> = {
  '~': 'Owners',
  '&': 'Admins',
  '@': 'Operators',
  '%': 'Half-operators',
  '+': 'Voiced',
  '': 'Users',
};

type RoleGroup = { prefix: string; label: string; users: ChannelUser[] };

/** Users arrive ranked by the server's PREFIX order, so groups keep first-seen order. */
function groupByRole(users: ChannelUser[]): RoleGroup[] {
  const groups = new Map<string, RoleGroup>();
  for (const user of users) {
    let group = groups.get(user.prefix);
    if (!group) {
      group = { prefix: user.prefix, label: roleNames[user.prefix] ?? `Mode ${user.prefix}`, users: [] };
      groups.set(user.prefix, group);
    }
    group.users.push(user);
  }
  return [...groups.values()];
}

export default function UserList({ channel, users, message, open, nickTheme, onClose, onUserMenu }: UserListProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return !users || !needle ? users : users.filter((user) => user.nick.toLocaleLowerCase().includes(needle));
  }, [users, query]);
  const groups = useMemo(() => filtered && groupByRole(filtered), [filtered]);

  function openMenu(event: MouseEvent<HTMLButtonElement>, nick: string) {
    event.preventDefault();
    // Keyboard-invoked context menus report no pointer position.
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX !== 0 || event.clientY !== 0;
    onUserMenu(nick, pointer ? event.clientX : rect.left, pointer ? event.clientY : rect.bottom);
  }

  return <aside id="channel-users" className={`user-panel${open ? ' user-panel-open' : ''}`} aria-label={`${channel} users`}>
    <div className="user-panel__header">
      <h2>Members{users && <span className="user-panel__count">{users.length}</span>}</h2>
      <button className="icon-button icon-button-small" type="button" aria-label="Close users" title="Hide users" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
    <div className="user-panel__search">
      <Icon name="search" />
      <label className="sr-only" htmlFor="user-search">Search users in {channel}</label>
      <input id="user-search" type="search" value={query} placeholder="Find a member" autoComplete="off"
        disabled={!users} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {!groups ? <p className="user-panel__status" role="status">{message}</p>
      : !groups.length ? <p className="user-panel__status">{query ? 'No matching users' : 'No users'}</p>
        : <div className="user-panel__list">
          {groups.map((group) => <section className="user-group" key={group.prefix}
            aria-label={`${group.label}: ${group.users.length}`}>
            <h3 className="user-group__heading">{group.label}<span>{group.users.length}</span></h3>
            <ul>
              {group.users.map((user) => <li key={user.nick}>
                <button type="button" className="user-entry" title={`${user.nick} — click for actions`}
                  onContextMenu={(event) => openMenu(event, user.nick)}
                  onClick={(event) => openMenu(event, user.nick)}>
                  <span className="user-entry__prefix" data-prefix={user.prefix}>{user.prefix}</span>
                  <span className="user-entry__nick"
                    style={nickTheme ? { color: nicknameColor(user.nick, nickTheme) } : undefined}>{user.nick}</span>
                </button>
              </li>)}
            </ul>
          </section>)}
        </div>}
    {filtered && query && users && filtered.length !== users.length
      && <p className="user-panel__footer">{filtered.length} of {users.length} shown</p>}
  </aside>;
}
