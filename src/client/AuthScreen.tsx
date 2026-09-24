import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorText, json } from './api';
import ThemePicker, { type Theme } from './ThemePicker';

export type AuthMode = 'checking' | 'setup' | 'login' | 'unavailable';

type AuthScreenProps = {
  mode: AuthMode;
  /** Explains why the user is here (for example an expired session or an unreachable server). */
  message: string;
  initialUsername: string;
  initialSetupToken: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onModeChange: (mode: AuthMode, message?: string) => void;
  /** Loads the signed-in session; rejects if that fails. */
  onAuthenticated: () => Promise<void>;
  onRetry: () => void;
};

/** Sign-in, first-run admin setup, and the "server unreachable" state. */
export default function AuthScreen({
  mode, message, initialUsername, initialSetupToken, theme, onThemeChange, onModeChange, onAuthenticated, onRetry,
}: AuthScreenProps) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState(initialSetupToken);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const shownError = error || message;
  useEffect(() => setError(''), [mode]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = username.trim();
    if (!name || !password || pending) return;
    setPending(true);
    setError('');
    try {
      await api<unknown>('/api/login', json('POST', { username: name, password }));
      await onAuthenticated();
    } catch (loginError) {
      if (loginError instanceof ApiError && loginError.status === 409) {
        setPassword('');
        onModeChange('setup');
      } else setError(errorText(loginError));
      setPending(false);
    }
  }

  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = username.trim();
    if (!name || !password || pending) return;
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    try {
      await api<unknown>('/api/setup', json('POST', { username: name, password, token: setupToken }));
      await onAuthenticated();
    } catch (setupError) {
      setPending(false);
      if (setupError instanceof ApiError && setupError.status === 409) {
        setPassword('');
        setConfirmPassword('');
        onModeChange('login', 'The admin account already exists. Sign in instead.');
      } else setError(errorText(setupError));
    }
  }

  return <main className="auth-screen">
    <div className="auth-card">
      <div className="auth-brand">
        <span className="auth-brand__logo" aria-hidden="true">&gt;_</span>
        <h1>lingo</h1>
      </div>
      <p className="auth-tagline">A quieter place for IRC.</p>
      {mode === 'checking' && <p className="auth-status" role="status"><span className="auth-spinner" aria-hidden="true" />Opening session…</p>}
      {mode === 'unavailable' && <div className="auth-form">
        <p className="error-text" role="alert">{message || 'Could not reach the server.'}</p>
        <button className="button button-primary" type="button" onClick={onRetry}>Try again</button>
      </div>}
      {mode === 'setup' && <form className="auth-form" onSubmit={(event) => void setup(event)}>
        <div className="auth-form__intro">
          <h2>Create the admin account</h2>
          <p>This account manages Lingo and creates accounts for other people.</p>
        </div>
        <label className="auth-field">
          <span>Setup token</span>
          <input type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} required
            value={setupToken} onChange={(event) => setSetupToken(event.target.value)} />
          {!initialSetupToken && <small>Printed by the server on first start.</small>}
        </label>
        <label className="auth-field">
          <span>Username</span>
          <input autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required maxLength={32}
            pattern="[A-Za-z0-9_.\-]+" title="Letters, numbers, dots, dashes, and underscores"
            value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
            value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
        </label>
        <label className="auth-field">
          <span>Confirm password</span>
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={1024}
            value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        {shownError && <p className="error-text" role="alert">{shownError}</p>}
        <button className="button button-primary auth-submit" type="submit"
          disabled={pending || !setupToken || !username.trim() || !password || !confirmPassword}>
          {pending ? 'Creating…' : 'Create account'}
        </button>
      </form>}
      {mode === 'login' && <form className="auth-form" onSubmit={(event) => void login(event)}>
        <label className="auth-field">
          <span>Username</span>
          <input autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!username} required
            value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" autoFocus={!!username} required
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {shownError && <p className="error-text" role="alert">{shownError}</p>}
        <button className="button button-primary auth-submit" type="submit" disabled={pending || !username.trim() || !password}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>}
    </div>
    <div className="auth-theme"><ThemePicker compact theme={theme} onChange={onThemeChange} /></div>
  </main>;
}
