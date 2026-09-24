import { useEffect, useState, type FormEvent } from 'react';
import type { AccountUser, AdminUserSummary } from '../../shared/contracts';
import { api, errorText, isSessionExpired, json } from '../api';
import Icon from '../Icon';
import { SettingsCard, SettingsField, SettingsStatus } from './SettingsControls';

/** Admin-only account management. */
export default function UsersSettings({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [pending, setPending] = useState<{ id: number; action: 'reset' | 'delete' | 'toggle' | 'limits' } | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [limitsId, setLimitsId] = useState<number | null>(null);
  const [maxNetworks, setMaxNetworks] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [limitsError, setLimitsError] = useState('');

  function fail(error: unknown, show: (message: string) => void) {
    if (isSessionExpired(error)) onUnauthorized();
    show(errorText(error));
  }

  async function loadUsers(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ users: AdminUserSummary[] }>('/api/users', { signal });
      if (!signal?.aborted) setUsers(result.users);
    } catch (error) {
      if (!signal?.aborted) fail(error, setError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = newUsername.trim();
    if (creating || pending !== null || !username || !newPassword) return;
    setCreating(true);
    setCreateError('');
    setCreateSuccess('');
    try {
      const created = await api<AccountUser>('/api/users', json('POST', { username, password: newPassword }));
      setNewUsername('');
      setNewPassword('');
      setCreateSuccess(`Created ${created.username}.`);
      await loadUsers();
    } catch (error) {
      fail(error, setCreateError);
    } finally {
      setCreating(false);
    }
  }

  function startReset(id: number) {
    setResetId(id);
    setResetPassword('');
    setActionError('');
    setActionSuccess('');
  }

  async function saveReset(event: FormEvent<HTMLFormElement>, target: AccountUser) {
    event.preventDefault();
    if (pending !== null || resetPassword.length < 8) return;
    setPending({ id: target.id, action: 'reset' });
    setActionError('');
    setActionSuccess('');
    try {
      await api<{ ok: true }>(`/api/users/${target.id}/password`, json('POST', { password: resetPassword }));
      setResetId(null);
      setResetPassword('');
      setActionSuccess(`Password reset for ${target.username}. Their sessions have been signed out.`);
      await loadUsers();
    } catch (error) {
      fail(error, setActionError);
    } finally {
      setPending(null);
    }
  }

  async function toggleUser(target: AdminUserSummary) {
    if (pending !== null) return;
    setPending({ id: target.id, action: 'toggle' });
    setActionError('');
    setActionSuccess('');
    try {
      const updated = await api<AdminUserSummary>(`/api/users/${target.id}`, json('PATCH', { disabled: !target.disabled }));
      setUsers((current) => current.map((user) => user.id === target.id ? updated : user));
      setActionSuccess(`${updated.username} ${updated.disabled ? 'disabled' : 'enabled'}.`);
    } catch (error) {
      fail(error, setActionError);
    } finally {
      setPending(null);
    }
  }

  async function deleteUser(target: AccountUser) {
    if (pending !== null) return;
    if (!confirm(`Delete ${target.username}? This permanently deletes their networks and chat history.`)) return;
    setPending({ id: target.id, action: 'delete' });
    setActionError('');
    setActionSuccess('');
    try {
      await api<{ ok: true }>(`/api/users/${target.id}`, { method: 'DELETE' });
      setUsers((current) => current.filter((user) => user.id !== target.id));
      if (resetId === target.id) setResetId(null);
      setActionSuccess(`Deleted ${target.username}.`);
    } catch (error) {
      fail(error, setActionError);
    } finally {
      setPending(null);
    }
  }

  function startLimits(target: AdminUserSummary) {
    if (pending !== null) return;
    setLimitsId(target.id);
    setMaxNetworks(target.maxNetworks === null ? '' : String(target.maxNetworks));
    setRetentionDays(target.retentionDays === null ? '' : String(target.retentionDays));
    setLimitsError('');
    setActionError('');
    setActionSuccess('');
  }

  async function saveLimits(event: FormEvent<HTMLFormElement>, target: AdminUserSummary) {
    event.preventDefault();
    if (pending !== null || limitsId !== target.id) return;
    const maxInput = maxNetworks.trim();
    const retentionInput = retentionDays.trim();
    const max = maxInput === '' ? null : Number(maxInput);
    const retention = retentionInput === '' ? null : Number(retentionInput);
    if (max !== null && (!/^\d+$/.test(maxInput) || !Number.isSafeInteger(max))) {
      setLimitsError('Network limit must be a whole number of zero or more.');
      return;
    }
    if (retention !== null && (!/^\d+$/.test(retentionInput) || !Number.isInteger(retention) || retention < 1 || retention > 3650)) {
      setLimitsError('History retention must be a whole number from 1 to 3650 days.');
      return;
    }
    setPending({ id: target.id, action: 'limits' });
    setLimitsError('');
    setActionError('');
    setActionSuccess('');
    try {
      const updated = await api<AdminUserSummary>(`/api/users/${target.id}`,
        json('PATCH', { maxNetworks: max, retentionDays: retention }));
      setUsers((current) => current.map((user) => user.id === target.id ? updated : user));
      setLimitsId(null);
      setActionSuccess(`Limits saved for ${updated.username}.`);
    } catch (error) {
      fail(error, setLimitsError);
    } finally {
      setPending(null);
    }
  }

  return <>
    <SettingsCard title="Add user" description="New users sign in with this username and password and manage their own networks.">
      <form className="settings-form" onSubmit={(event) => void createUser(event)}>
        <div className="settings-grid">
          <SettingsField label="Username" htmlFor="new-user-name">
            <input id="new-user-name" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={32}
              pattern="[A-Za-z0-9_.\-]+" title="Letters, numbers, dots, dashes, and underscores" value={newUsername}
              onChange={(event) => { setNewUsername(event.target.value); setCreateSuccess(''); }} disabled={creating} />
          </SettingsField>
          <SettingsField label="Password" htmlFor="new-user-password">
            <input id="new-user-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
              value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={creating}
              placeholder="At least 8 characters" />
          </SettingsField>
        </div>
        <div className="settings-form__actions">
          <button className="button button-primary" type="submit"
            disabled={creating || pending !== null || !newUsername.trim() || !newPassword}>
            {creating ? 'Creating…' : 'Create user'}</button>
        </div>
        <SettingsStatus error={createError} success={createSuccess} />
      </form>
    </SettingsCard>
    <SettingsCard title="Accounts"
      actions={<button className="button button-quiet button-small" type="button" onClick={() => void loadUsers()}
        disabled={loading || pending !== null}><Icon name="rotate" />Refresh</button>}>
      {(loading || error) && <div className="settings-row">
        {loading && <p className="settings-help" role="status">Loading users…</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>}
      {users.length > 0 && <ul className="settings-list">{users.map((user) => <li className="settings-list__item" key={user.id}>
        <div className="settings-list__main">
          <span className="settings-list__title">{user.username}
            {user.isAdmin && <span className="badge badge-accent">Admin</span>}
            {user.disabled && <span className="badge settings-badge-danger">Disabled</span>}</span>
          <span className="settings-help">Created {new Date(user.createdAt).toLocaleDateString()}
            {' · '}Last login: {user.lastLoginAt === null ? 'Never' : new Date(user.lastLoginAt).toLocaleString()}</span>
          <span className="settings-help">Networks: {user.connectedCount} connected / {user.networkCount} total · Active sessions: {user.sessionCount}</span>
          <span className="settings-help">
            Network limit: {user.maxNetworks === null ? 'Unlimited' : user.maxNetworks}
            {' · '}History retention: {user.retentionDays === null ? 'Global default' : `${user.retentionDays} days`}
          </span>
        </div>
        <div className="settings-list__actions">
          <button className="button button-quiet button-small" type="button" disabled={pending !== null}
            aria-expanded={limitsId === user.id}
            onClick={() => limitsId === user.id ? setLimitsId(null) : startLimits(user)}>
            {limitsId === user.id ? 'Cancel limit changes' : 'Edit limits'}
          </button>
          {!user.isAdmin && <>
            <button className="button button-quiet button-small" type="button" disabled={pending !== null} aria-expanded={resetId === user.id}
              onClick={() => resetId === user.id ? setResetId(null) : startReset(user.id)}>Reset password</button>
            <button className={user.disabled ? 'button button-small' : 'button button-danger button-small'} type="button"
              disabled={pending !== null} onClick={() => void toggleUser(user)}>{pending?.id === user.id && pending.action === 'toggle'
                ? (user.disabled ? 'Enabling…' : 'Disabling…') : (user.disabled ? 'Enable' : 'Disable')}</button>
            <button className="button button-danger button-small" type="button" disabled={pending !== null}
              onClick={() => void deleteUser(user)}>{pending?.id === user.id && pending.action === 'delete' ? 'Deleting…' : 'Delete'}</button>
          </>}
        </div>
        {limitsId === user.id && <form className="settings-form settings-list__form" onSubmit={(event) => void saveLimits(event, user)}>
          <div className="settings-grid">
            <SettingsField label="Maximum networks" htmlFor={`max-networks-${user.id}`} helpId={`max-networks-help-${user.id}`}
              help="Leave blank for unlimited; 0 prevents new networks.">
              <input id={`max-networks-${user.id}`} type="text" inputMode="numeric" autoComplete="off"
                aria-describedby={`max-networks-help-${user.id}`} placeholder="Unlimited (leave blank)"
                value={maxNetworks} onChange={(event) => { setMaxNetworks(event.target.value); setLimitsError(''); }}
                disabled={pending !== null} />
            </SettingsField>
            <SettingsField label="History retention (days)" htmlFor={`retention-days-${user.id}`} helpId={`retention-days-help-${user.id}`}
              help="Leave blank to use the global default; otherwise 1–3650 days.">
              <input id={`retention-days-${user.id}`} type="text" inputMode="numeric" autoComplete="off"
                aria-describedby={`retention-days-help-${user.id}`} placeholder="Global default (leave blank)"
                value={retentionDays} onChange={(event) => { setRetentionDays(event.target.value); setLimitsError(''); }}
                disabled={pending !== null} />
            </SettingsField>
          </div>
          <div className="settings-form__actions">
            <button className="button button-primary" type="submit" disabled={pending !== null}>
              {pending?.id === user.id && pending.action === 'limits' ? 'Saving…' : 'Save limits'}
            </button>
          </div>
          <SettingsStatus error={limitsError} />
        </form>}
        {resetId === user.id && <form className="settings-list__form settings-inline-form" onSubmit={(event) => void saveReset(event, user)}>
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={1024} autoFocus
            aria-label={`New password for ${user.username}`} placeholder="New password (at least 8 characters)"
            value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} disabled={pending !== null} />
          <button className="button button-primary" type="submit" disabled={pending !== null || resetPassword.length < 8}>
            {pending?.id === user.id && pending.action === 'reset' ? 'Saving…' : 'Set password'}</button>
          <button className="button button-quiet" type="button" onClick={() => setResetId(null)} disabled={pending !== null}>Cancel</button>
        </form>}
      </li>)}</ul>}
      {(actionError || actionSuccess) && <div className="settings-row">
        <SettingsStatus error={actionError} success={actionSuccess} />
      </div>}
    </SettingsCard>
  </>;
}
