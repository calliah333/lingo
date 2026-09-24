import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccountUser, AdminUserSummary, SyncedSettings } from '../shared/contracts';
import { api, ApiError, json } from './api';
import { currentPushSubscription, disablePush, enablePush } from './push';
import ThemePicker from './ThemePicker';
import {
  fontFamilies, maxFontSize, maxNickWidth, minFontSize, minNickWidth, type AppPreferences, type FontFamily,
} from './preferences';

type AccountSession = { id: string; createdAt: number; expiresAt: number; current: boolean };
type GlobalSettingsProps = {
  user: AccountUser;
  preferences: AppPreferences;
  settings: SyncedSettings;
  onSettingsChange: (patch: Partial<SyncedSettings>) => void;
  onChange: (preferences: AppPreferences) => void;
  onEnableNotifications: () => Promise<void>;
  onSoundChange: (enabled: boolean) => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `Request failed (${response.status})`;
    if (response.status === 401 && message !== 'Invalid password') throw new Error(`Session expired: ${message}`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/** Admin-only account management. */
function UsersSection({ onUnauthorized }: { onUnauthorized: () => void }) {
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
    if (errorText(error).startsWith('Session expired:')) onUnauthorized();
    show(errorText(error));
  }

  async function loadUsers(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const result = await request<{ users: AdminUserSummary[] }>('/api/users', { signal });
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
      const created = await request<AccountUser>('/api/users', json('POST', { username, password: newPassword }));
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
      await request<{ ok: true }>(`/api/users/${target.id}/password`, json('POST', { password: resetPassword }));
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
      const updated = await request<AdminUserSummary>(`/api/users/${target.id}`, json('PATCH', { disabled: !target.disabled }));
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
      await request<{ ok: true }>(`/api/users/${target.id}`, { method: 'DELETE' });
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
      const updated = await request<AdminUserSummary>(`/api/users/${target.id}`,
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


  return <section className="global-settings__section" aria-labelledby="users-heading">
    <h3 id="users-heading">Users</h3>
    <form className="settings-form global-settings__form" onSubmit={(event) => void createUser(event)}>
      <h4>Add user</h4>
      <label className="settings-field" htmlFor="new-user-name">Username</label>
      <input id="new-user-name" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={32}
        pattern="[A-Za-z0-9_.\-]+" title="Letters, numbers, dots, dashes, and underscores" value={newUsername}
        onChange={(event) => { setNewUsername(event.target.value); setCreateSuccess(''); }} disabled={creating} />
      <label className="settings-field" htmlFor="new-user-password">Password</label>
      <input id="new-user-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
        value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={creating}
        placeholder="At least 8 characters" />
      <button className="button button-primary global-settings__submit" type="submit"
        disabled={creating || pending !== null || !newUsername.trim() || !newPassword}>{creating ? 'Creating…' : 'Create user'}</button>
      {createError && <p className="settings-error" role="alert">{createError}</p>}
      {createSuccess && <p className="global-settings__success" role="status">{createSuccess}</p>}
    </form>
    <div className="global-settings__list-block">
      <div className="global-settings__list-heading"><h4>Accounts</h4>
        <button className="button button-quiet" type="button" onClick={() => void loadUsers()} disabled={loading || pending !== null}>Refresh</button></div>
      {loading && <p className="settings-help" role="status">Loading users…</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <ul className="global-settings__list">{users.map((user) => <li key={user.id}>
        <div><span><strong>{user.username}</strong>
          {user.isAdmin && <span className="global-settings__badge">Admin</span>}
          {user.disabled && <span className="global-settings__badge">Disabled</span>}</span>
          <span className="settings-help">Created {new Date(user.createdAt).toLocaleDateString()}</span>
          <span className="settings-help">Last login: {user.lastLoginAt === null ? 'Never' : new Date(user.lastLoginAt).toLocaleString()}</span>
          <span className="settings-help">Networks: {user.connectedCount} connected / {user.networkCount} total · Active sessions: {user.sessionCount}</span></div>
        <div className="settings-help">
          Network limit: {user.maxNetworks === null ? 'Unlimited' : user.maxNetworks}
          {' · '}History retention: {user.retentionDays === null ? 'Global default' : `${user.retentionDays} days`}
        </div>
        <button className="button button-quiet" type="button" disabled={pending !== null}
          aria-expanded={limitsId === user.id}
          onClick={() => limitsId === user.id ? setLimitsId(null) : startLimits(user)}>
          {limitsId === user.id ? 'Cancel limit changes' : 'Edit limits'}
        </button>
        {limitsId === user.id && <form className="settings-form global-settings__form" style={{ flex: '1 0 100%' }}
          onSubmit={(event) => void saveLimits(event, user)}>
          <label className="settings-field" htmlFor={`max-networks-${user.id}`}>Maximum networks</label>
          <input id={`max-networks-${user.id}`} type="text" inputMode="numeric" autoComplete="off"
            aria-describedby={`max-networks-help-${user.id}`} placeholder="Unlimited (leave blank)"
            value={maxNetworks} onChange={(event) => { setMaxNetworks(event.target.value); setLimitsError(''); }}
            disabled={pending !== null} />
          <span className="settings-help" id={`max-networks-help-${user.id}`}>Leave blank for unlimited; 0 prevents new networks.</span>
          <label className="settings-field" htmlFor={`retention-days-${user.id}`}>History retention (days)</label>
          <input id={`retention-days-${user.id}`} type="text" inputMode="numeric" autoComplete="off"
            aria-describedby={`retention-days-help-${user.id}`} placeholder="Global default (leave blank)"
            value={retentionDays} onChange={(event) => { setRetentionDays(event.target.value); setLimitsError(''); }}
            disabled={pending !== null} />
          <span className="settings-help" id={`retention-days-help-${user.id}`}>Leave blank to use the global default; otherwise 1–3650 days.</span>
          <button className="button button-primary global-settings__submit" type="submit" disabled={pending !== null}>
            {pending?.id === user.id && pending.action === 'limits' ? 'Saving…' : 'Save limits'}
          </button>
          {limitsError && <p className="settings-error" role="alert">{limitsError}</p>}
        </form>}
        {!user.isAdmin && <div className="global-settings__row-actions">
          <button className={user.disabled ? 'button button-quiet' : 'button button-danger'} type="button" disabled={pending !== null}
            onClick={() => void toggleUser(user)}>{pending?.id === user.id && pending.action === 'toggle'
              ? (user.disabled ? 'Enabling…' : 'Disabling…') : (user.disabled ? 'Enable' : 'Disable')}</button>
          <button className="button button-quiet" type="button" disabled={pending !== null} aria-expanded={resetId === user.id}
            onClick={() => resetId === user.id ? setResetId(null) : startReset(user.id)}>Reset password</button>
          <button className="button button-danger" type="button" disabled={pending !== null}
            onClick={() => void deleteUser(user)}>{pending?.id === user.id && pending.action === 'delete' ? 'Deleting…' : 'Delete'}</button>
        </div>}
        {resetId === user.id && <form className="global-settings__reset" onSubmit={(event) => void saveReset(event, user)}>
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={1024} autoFocus
            aria-label={`New password for ${user.username}`} placeholder="New password (at least 8 characters)"
            value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} disabled={pending !== null} />
          <button className="button button-primary" type="submit" disabled={pending !== null || resetPassword.length < 8}>
            {pending?.id === user.id && pending.action === 'reset' ? 'Saving…' : 'Set password'}</button>
          <button className="button button-quiet" type="button" onClick={() => setResetId(null)} disabled={pending !== null}>Cancel</button>
        </form>}
      </li>)}</ul>
      {actionError && <p className="settings-error" role="alert">{actionError}</p>}
      {actionSuccess && <p className="global-settings__success" role="status">{actionSuccess}</p>}
    </div>
  </section>;
}

export default function GlobalSettings({
  user, preferences, settings, onChange, onSettingsChange, onEnableNotifications, onSoundChange, onClose, onUnauthorized,
}: GlobalSettingsProps) {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [away, setAway] = useState('');
  const [awayLoading, setAwayLoading] = useState(true);
  const [awaySaving, setAwaySaving] = useState(false);
  const [awayError, setAwayError] = useState('');
  const [awaySuccess, setAwaySuccess] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [notificationError, setNotificationError] = useState('');
  const [notificationPending, setNotificationPending] = useState(false);
  const [highlightDraft, setHighlightDraft] = useState(() => settings.highlights.join('\n'));
  const highlightEditing = useRef(false);
  const highlightDirty = useRef(false);
  const highlightTimer = useRef<number | undefined>(undefined);
  const highlightText = useRef(highlightDraft);
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [pushPending, setPushPending] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushSuccess, setPushSuccess] = useState('');

  useEffect(() => {
    let active = true;
    void currentPushSubscription().then((subscription) => { if (active) setPushEnabled(subscription !== null); },
      () => { if (active) setPushEnabled(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!highlightEditing.current) {
      highlightText.current = settings.highlights.join('\n');
      setHighlightDraft(highlightText.current);
    }
  }, [settings.highlights]);
  useEffect(() => () => {
    clearTimeout(highlightTimer.current);
  }, []);

  function commitHighlights() {
    highlightTimer.current = undefined;
    if (!highlightDirty.current) return;
    highlightDirty.current = false;
    onSettingsChange({ highlights: [...new Set(highlightText.current.split(/[,\n]/)
      .map((phrase) => phrase.trim()).filter(Boolean))] });
  }

  function update<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    onChange({ ...preferences, [key]: value });
  }

  async function loadSessions(signal?: AbortSignal) {
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const result = await request<{ sessions: AccountSession[] }>('/api/account/sessions', { signal });
      if (!signal?.aborted) setSessions(result.sessions);
    } catch (error) {
      if (!signal?.aborted) {
        if (errorText(error).startsWith('Session expired:')) onUnauthorized();
        setSessionsError(errorText(error));
      }
    } finally {
      if (!signal?.aborted) setSessionsLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadSessions(controller.signal);
    void request<{ message: string }>('/api/settings/away', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setAway(result.message); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          if (errorText(error).startsWith('Session expired:')) onUnauthorized();
          setAwayError(errorText(error));
        }
      }).finally(() => { if (!controller.signal.aborted) setAwayLoading(false); });
    return () => controller.abort();
  }, []);

  async function saveAway(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (awaySaving) return;
    setAwaySaving(true);
    setAwayError('');
    setAwaySuccess('');
    try {
      const result = await request<{ message: string }>('/api/settings/away', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: away }),
      });
      setAway(result.message);
      setAwaySuccess('Away message saved.');
    } catch (error) {
      if (errorText(error).startsWith('Session expired:')) onUnauthorized();
      setAwayError(errorText(error));
    } finally {
      setAwaySaving(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordSaving) return;
    setPasswordError('');
    setPasswordSuccess('');
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setPasswordSaving(true);
    try {
      await request<{ ok: true }>('/api/account/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Password changed. Other sessions have been signed out.');
      void loadSessions();
    } catch (error) {
      if (errorText(error).startsWith('Session expired:')) onUnauthorized();
      setPasswordError(errorText(error));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function revokeSession(id: string) {
    if (revoking !== null) return;
    setRevoking(id);
    setSessionsError('');
    try {
      await request<{ ok: true }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSessions((current) => current.filter((session) => session.id !== id));
    } catch (error) {
      if (errorText(error).startsWith('Session expired:')) onUnauthorized();
      setSessionsError(errorText(error));
    } finally {
      setRevoking(null);
    }
  }

  async function enableNotifications() {
    setNotificationPending(true);
    setNotificationError('');
    try {
      await onEnableNotifications();
    } catch (error) {
      setNotificationError(errorText(error));
    } finally {
      setNotificationPending(false);
    }
  }

  async function pushAction(action: () => Promise<void>) {
    setPushPending(true);
    setPushError('');
    setPushSuccess('');
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      setPushError(errorText(error));
    } finally {
      setPushEnabled(await currentPushSubscription().then((subscription) => subscription !== null, () => false));
      setPushPending(false);
    }
  }

  function sendTestPush() {
    return pushAction(async () => {
      await api<{ delivered: number }>('/api/push/test', { method: 'POST' });
      setPushSuccess('Test notification sent.');
    });
  }

  return <section className="global-settings settings-panel" aria-label="Global settings">
    <header className="settings-header"><h2>Settings</h2>
      <button className="button button-quiet" type="button" onClick={onClose}>Close</button>
    </header>
    <section className="global-settings__section" aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance</h3>
      <ThemePicker theme={preferences.theme} onChange={(theme) => update('theme', theme)} />
      <label className="settings-field" htmlFor="font-family">Font</label>
      <select id="font-family" value={preferences.fontFamily}
        onChange={(event) => update('fontFamily', event.target.value as FontFamily)}>
        {Object.entries(fontFamilies).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="settings-field" htmlFor="font-size">Font size</label>
      <select id="font-size" value={preferences.fontSize}
        onChange={(event) => update('fontSize', Number(event.target.value))}>
        {Array.from({ length: maxFontSize - minFontSize + 1 }, (_, index) => minFontSize + index)
          .map((size) => <option key={size} value={size}>{size}px</option>)}
      </select>
      <label className="settings-field" htmlFor="nick-width">Nickname column width</label>
      <select id="nick-width" value={preferences.nickWidth}
        onChange={(event) => update('nickWidth', Number(event.target.value))}>
        {Array.from({ length: maxNickWidth - minNickWidth + 1 }, (_, index) => minNickWidth + index)
          .map((width) => <option key={width} value={width}>{width} characters</option>)}
      </select>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.coloredNicknames}
        onChange={(event) => update('coloredNicknames', event.target.checked)} /> Colored nicknames</label>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.showSeconds}
        onChange={(event) => update('showSeconds', event.target.checked)} /> Show seconds in timestamps</label>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.twelveHour}
        onChange={(event) => update('twelveHour', event.target.checked)} /> Use 12-hour time</label>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.showMotd}
        onChange={(event) => update('showMotd', event.target.checked)} /> Show server MOTD</label>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.autocomplete}
        onChange={(event) => update('autocomplete', event.target.checked)} /> Autocomplete mentions and commands</label>
      <label className="settings-field" htmlFor="status-messages">Status messages</label>
      <select id="status-messages" value={preferences.statusMessages}
        onChange={(event) => update('statusMessages', event.target.value as AppPreferences['statusMessages'])}>
        <option value="inline">Show inline</option>
        <option value="compact">Compact</option>
        <option value="hidden">Hide</option>
      </select>
    </section>
    <section className="global-settings__section" aria-labelledby="general-heading">
      <h3 id="general-heading">General</h3>
      <form className="settings-form global-settings__form" onSubmit={(event) => void saveAway(event)}>
        <label className="settings-field" htmlFor="away-message">Away message</label>
        <input id="away-message" value={away} disabled={awayLoading || awaySaving} maxLength={300}
          onChange={(event) => { setAway(event.target.value); setAwaySuccess(''); }} placeholder="Shown when no browser clients are connected" />
        <span className="settings-help">Saved on the server and used automatically when you disconnect. Leave blank to disable.</span>
        <div className="global-settings__actions"><button className="button button-primary" type="submit" disabled={awayLoading || awaySaving}>
          {awaySaving ? 'Saving…' : 'Save away message'}</button>
          {awayLoading && <span role="status" className="settings-help">Loading…</span>}</div>
        {awayError && <p className="settings-error" role="alert">{awayError}</p>}
        {awaySuccess && <p className="global-settings__success" role="status">{awaySuccess}</p>}
      </form>
    </section>
    <section className="global-settings__section" aria-labelledby="notifications-heading">
      <h3 id="notifications-heading">Notifications</h3>
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.browserNotifications} disabled={notificationPending}
        onChange={(event) => event.target.checked ? void enableNotifications() : update('browserNotifications', false)} /> Browser notifications</label>
      {notificationError && <p className="settings-error" role="alert">{notificationError}</p>}
      <label className="settings-checkbox"><input type="checkbox" checked={preferences.notificationSound}
        onChange={(event) => onSoundChange(event.target.checked)} /> Notification sound</label>
      <label className="settings-checkbox"><input type="checkbox" checked={pushEnabled === true}
        disabled={pushEnabled === null || pushPending}
        onChange={(event) => void pushAction(event.target.checked ? enablePush : disablePush)} /> Push notifications on this device</label>
      <span className="settings-help">Mentions and private messages are pushed while no Lingo window is open, even when the browser is closed. On iPhone and iPad, add Lingo to the home screen and enable push from there.</span>
      <label className="settings-checkbox"><input type="checkbox" checked={settings.pushIncludesText}
        onChange={(event) => onSettingsChange({ pushIncludesText: event.target.checked })} /> Include message text in pushes</label>
      <span className="settings-help">When off, pushes only say who wrote, keeping message text off lock screens. Applies to all your devices.</span>
      <div className="global-settings__actions">
        <button className="button" type="button" disabled={!pushEnabled || pushPending} onClick={() => void sendTestPush()}>
          Send test notification</button>
        {pushPending && <span role="status" className="settings-help">Working…</span>}</div>
      {pushError && <p className="settings-error" role="alert">{pushError}</p>}
      {pushSuccess && <p className="global-settings__success" role="status">{pushSuccess}</p>}
      <label className="settings-field" htmlFor="highlight-phrases">Custom highlight phrases</label>
      <textarea id="highlight-phrases" rows={3} value={highlightDraft} placeholder="One phrase per line"
        onFocus={() => { highlightEditing.current = true; }}
        onBlur={() => {
          clearTimeout(highlightTimer.current);
          const changed = highlightDirty.current;
          commitHighlights();
          highlightEditing.current = false;
          if (!changed) {
            highlightText.current = settings.highlights.join('\n');
            setHighlightDraft(highlightText.current);
          }
        }}
        onChange={(event) => {
          highlightText.current = event.target.value;
          highlightDirty.current = true;
          setHighlightDraft(event.target.value);
          clearTimeout(highlightTimer.current);
          highlightTimer.current = window.setTimeout(commitHighlights, 450);
        }} />
      <span className="settings-help">Case-insensitive literal phrases, separated by lines or commas. Mentions of your nick also count.</span>
    </section>
    <section className="global-settings__section" aria-labelledby="account-heading">
      <h3 id="account-heading">Account</h3>
      <p className="global-settings__identity">Signed in as <strong>{user.username}</strong>{user.isAdmin && ' (admin)'}</p>
      <form className="settings-form global-settings__form" onSubmit={(event) => void savePassword(event)}>
        <h4>Change password</h4>
        <input type="text" autoComplete="username" value={user.username} readOnly hidden />
        <label className="settings-field" htmlFor="current-password">Current password</label>
        <input id="current-password" type="password" autoComplete="current-password" required value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)} disabled={passwordSaving} />
        <label className="settings-field" htmlFor="new-password">New password</label>
        <input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)} disabled={passwordSaving} />
        <label className="settings-field" htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)} disabled={passwordSaving} />
        <button className="button button-primary global-settings__submit" type="submit" disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}>
          {passwordSaving ? 'Changing…' : 'Change password'}</button>
        {passwordError && <p className="settings-error" role="alert">{passwordError}</p>}
        {passwordSuccess && <p className="global-settings__success" role="status">{passwordSuccess}</p>}
      </form>
      <div className="global-settings__list-block">
        <div className="global-settings__list-heading"><h4>Active sessions</h4>
          <button className="button button-quiet" type="button" onClick={() => void loadSessions()} disabled={sessionsLoading}>Refresh</button></div>
        {sessionsLoading && <p className="settings-help" role="status">Loading sessions…</p>}
        {sessionsError && <p className="settings-error" role="alert">{sessionsError}</p>}
        {!sessionsLoading && !sessionsError && !sessions.length && <p className="settings-help">No active sessions.</p>}
        <ul className="global-settings__list">{sessions.map((session) => <li key={session.id}>
          <div><span><strong>{session.current ? 'This browser' : 'Other session'}</strong>
            {session.current && <span className="global-settings__badge">Current</span>}</span>
            <span className="settings-help">Signed in {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</span></div>
          {!session.current && <button className="button button-danger" type="button" disabled={revoking !== null}
            onClick={() => void revokeSession(session.id)}>{revoking === session.id ? 'Revoking…' : 'Revoke'}</button>}
        </li>)}</ul>
      </div>
    </section>
    {user.isAdmin && <UsersSection onUnauthorized={onUnauthorized} />}
  </section>;
}
