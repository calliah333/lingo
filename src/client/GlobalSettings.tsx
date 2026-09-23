import { useEffect, useState, type FormEvent } from 'react';
import ThemePicker from './ThemePicker';
import {
  fontFamilies, maxFontSize, maxNickWidth, minFontSize, minNickWidth, type AppPreferences, type FontFamily,
} from './preferences';

type AccountSession = { id: string; createdAt: number; expiresAt: number; current: boolean };
type GlobalSettingsProps = {
  preferences: AppPreferences;
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

export default function GlobalSettings({ preferences, onChange, onEnableNotifications, onSoundChange, onClose, onUnauthorized }: GlobalSettingsProps) {
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
  const [highlightDraft, setHighlightDraft] = useState(() => preferences.highlights.join('\n'));

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
      <label className="settings-field" htmlFor="highlight-phrases">Custom highlight phrases</label>
      <textarea id="highlight-phrases" rows={3} value={highlightDraft} placeholder="One phrase per line"
        onChange={(event) => {
          const value = event.target.value;
          setHighlightDraft(value);
          update('highlights', [...new Set(value.split(/[,\n]/).map((phrase) => phrase.trim()).filter(Boolean))]);
        }} />
      <span className="settings-help">Case-insensitive literal phrases, separated by lines or commas. Mentions of your nick also count.</span>
    </section>
    <section className="global-settings__section" aria-labelledby="account-heading">
      <h3 id="account-heading">Account</h3>
      <form className="settings-form global-settings__form" onSubmit={(event) => void savePassword(event)}>
        <h4>Change password</h4>
        <label className="settings-field" htmlFor="current-password">Current password</label>
        <input id="current-password" type="password" autoComplete="current-password" required value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)} disabled={passwordSaving} />
        <label className="settings-field" htmlFor="new-password">New password</label>
        <input id="new-password" type="password" autoComplete="new-password" required value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)} disabled={passwordSaving} />
        <label className="settings-field" htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" type="password" autoComplete="new-password" required value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)} disabled={passwordSaving} />
        <button className="button button-primary global-settings__submit" type="submit" disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}>
          {passwordSaving ? 'Changing…' : 'Change password'}</button>
        {passwordError && <p className="settings-error" role="alert">{passwordError}</p>}
        {passwordSuccess && <p className="global-settings__success" role="status">{passwordSuccess}</p>}
      </form>
      <div className="global-settings__sessions">
        <div className="global-settings__sessions-heading"><h4>Active sessions</h4>
          <button className="button button-quiet" type="button" onClick={() => void loadSessions()} disabled={sessionsLoading}>Refresh</button></div>
        {sessionsLoading && <p className="settings-help" role="status">Loading sessions…</p>}
        {sessionsError && <p className="settings-error" role="alert">{sessionsError}</p>}
        {!sessionsLoading && !sessionsError && !sessions.length && <p className="settings-help">No active sessions.</p>}
        <ul className="global-settings__session-list">{sessions.map((session) => <li key={session.id}>
          <div><strong>{session.current ? 'This browser' : 'Other session'}</strong>
            {session.current && <span className="global-settings__current">Current</span>}
            <span className="settings-help">Signed in {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</span></div>
          {!session.current && <button className="button button-danger" type="button" disabled={revoking !== null}
            onClick={() => void revokeSession(session.id)}>{revoking === session.id ? 'Revoking…' : 'Revoke'}</button>}
        </li>)}</ul>
      </div>
    </section>
  </section>;
}
