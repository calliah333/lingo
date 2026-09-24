import { useEffect, useState, type FormEvent } from 'react';
import type { AccountUser } from '../../shared/contracts';
import { api, errorText, isSessionExpired, json } from '../api';
import Icon from '../Icon';
import { SettingsCard, SettingsField, SettingsStatus } from './SettingsControls';

type AccountSession = { id: string; createdAt: number; expiresAt: number; current: boolean };

type AccountSettingsProps = {
  user: AccountUser;
  onUnauthorized: () => void;
};

/** The signed-in account: identity, password, and sessions on other devices. */
export default function AccountSettings({ user, onUnauthorized }: AccountSettingsProps) {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  async function loadSessions(signal?: AbortSignal) {
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const result = await api<{ sessions: AccountSession[] }>('/api/account/sessions', { signal });
      if (!signal?.aborted) setSessions(result.sessions);
    } catch (error) {
      if (!signal?.aborted) {
        if (isSessionExpired(error)) onUnauthorized();
        setSessionsError(errorText(error));
      }
    } finally {
      if (!signal?.aborted) setSessionsLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadSessions(controller.signal);
    return () => controller.abort();
  }, []);

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
      await api<{ ok: true }>('/api/account/password', json('POST', { currentPassword, newPassword }));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Password changed. Other sessions have been signed out.');
      void loadSessions();
    } catch (error) {
      if (isSessionExpired(error)) onUnauthorized();
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
      await api<{ ok: true }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSessions((current) => current.filter((session) => session.id !== id));
    } catch (error) {
      if (isSessionExpired(error)) onUnauthorized();
      setSessionsError(errorText(error));
    } finally {
      setRevoking(null);
    }
  }

  return <>
    <SettingsCard title="Identity">
      <div className="settings-row settings-identity">
        <span className="settings-identity__avatar" aria-hidden="true"><Icon name="user" /></span>
        <p className="settings-identity__text">Signed in as <strong>{user.username}</strong>
          {user.isAdmin && <span className="badge badge-accent">Admin</span>}</p>
      </div>
    </SettingsCard>
    <SettingsCard title="Change password" description="Changing your password signs out your other sessions.">
      <form className="settings-form" onSubmit={(event) => void savePassword(event)}>
        <input type="text" autoComplete="username" value={user.username} readOnly hidden />
        <SettingsField label="Current password" htmlFor="current-password">
          <input id="current-password" type="password" autoComplete="current-password" required value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)} disabled={passwordSaving} />
        </SettingsField>
        <div className="settings-grid">
          <SettingsField label="New password" htmlFor="new-password">
            <input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
              value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={passwordSaving}
              placeholder="At least 8 characters" />
          </SettingsField>
          <SettingsField label="Confirm new password" htmlFor="confirm-password">
            <input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
              value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={passwordSaving} />
          </SettingsField>
        </div>
        <div className="settings-form__actions">
          <button className="button button-primary" type="submit"
            disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}>
            {passwordSaving ? 'Changing…' : 'Change password'}</button>
        </div>
        <SettingsStatus error={passwordError} success={passwordSuccess} />
      </form>
    </SettingsCard>
    <SettingsCard title="Active sessions" description="Browsers and devices signed in to this account."
      actions={<button className="button button-quiet button-small" type="button" onClick={() => void loadSessions()}
        disabled={sessionsLoading}><Icon name="rotate" />Refresh</button>}>
      {(sessionsLoading || sessionsError || !sessions.length) && <div className="settings-row">
        {sessionsLoading && <p className="settings-help" role="status">Loading sessions…</p>}
        {sessionsError && <p className="error-text" role="alert">{sessionsError}</p>}
        {!sessionsLoading && !sessionsError && !sessions.length && <p className="settings-help">No active sessions.</p>}
      </div>}
      {sessions.length > 0 && <ul className="settings-list">{sessions.map((session) => <li className="settings-list__item" key={session.id}>
        <div className="settings-list__main">
          <span className="settings-list__title">{session.current ? 'This browser' : 'Other session'}
            {session.current && <span className="badge badge-accent">Current</span>}</span>
          <span className="settings-help">Signed in {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</span>
        </div>
        {!session.current && <div className="settings-list__actions">
          <button className="button button-danger button-small" type="button" disabled={revoking !== null}
            onClick={() => void revokeSession(session.id)}>{revoking === session.id ? 'Revoking…' : 'Revoke'}</button>
        </div>}
      </li>)}</ul>}
    </SettingsCard>
  </>;
}
