import { useEffect, useRef, useState } from 'react';
import type { UploadPage, UploadRecord } from '../../shared/contracts';
import { api, ApiError, errorText, isSessionExpired } from '../api';
import Icon from '../Icon';
import { formatBytes } from '../uploads';
import { SettingsCard, SettingsStatus } from './SettingsControls';

const PAGE_SIZE = 50;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Expires in 3 hours" within a week, a date after that. */
function expiryText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return 'Permanent';
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Expired';
  if (remaining >= 7 * DAY) return `Expires ${new Date(expiresAt).toLocaleDateString()}`;
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = remaining < HOUR ? [Math.ceil(remaining / MINUTE), 'minute']
    : remaining < DAY ? [Math.round(remaining / HOUR), 'hour'] : [Math.round(remaining / DAY), 'day'];
  return `Expires ${new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(amount, unit)}`;
}

/** The user's unexpired teacup uploads: copy a link again or delete the file. */
export default function UploadsSettings({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const copiedTimer = useRef<number | undefined>(undefined);
  const now = Date.now();

  function fail(error: unknown, show: (message: string) => void) {
    if (isSessionExpired(error)) onUnauthorized();
    show(errorText(error));
  }

  async function loadUploads(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const page = await api<UploadPage>(`/api/uploads?limit=${PAGE_SIZE}`, { signal });
      if (signal?.aborted) return;
      setUploads(page.uploads);
      setHasMore(page.hasMore);
    } catch (error) {
      if (!signal?.aborted) fail(error, setError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadUploads(controller.signal);
    return () => {
      controller.abort();
      window.clearTimeout(copiedTimer.current);
    };
  }, []);

  async function loadMore() {
    const last = uploads.at(-1);
    if (!last || loading || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams({ before: String(last.id), limit: String(PAGE_SIZE) });
      const page = await api<UploadPage>(`/api/uploads?${params}`);
      setUploads((current) => {
        const known = new Set(current.map((upload) => upload.id));
        return [...current, ...page.uploads.filter((upload) => !known.has(upload.id))];
      });
      setHasMore(page.hasMore);
    } catch (error) {
      fail(error, setError);
    } finally {
      setLoadingMore(false);
    }
  }

  async function copyLink(upload: UploadRecord) {
    setActionError('');
    setActionSuccess('');
    try {
      // `navigator.clipboard` exists only in secure contexts.
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(upload.url);
      setCopied(upload.id);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setActionError(`Could not copy the link to ${upload.filename}. Select it and copy it instead.`);
    }
  }

  async function deleteUpload(upload: UploadRecord) {
    if (pending !== null) return;
    if (!confirm(`Delete ${upload.filename}? Its link stops working, including in messages already sent.`)) return;
    setPending(upload.id);
    setActionError('');
    setActionSuccess('');
    try {
      await api<{ ok: true }>(`/api/uploads/${upload.id}`, { method: 'DELETE' });
      setUploads((current) => current.filter((item) => item.id !== upload.id));
      setActionSuccess(`Deleted ${upload.filename}.`);
    } catch (error) {
      // Only your own uploads are listed, so a 404 means it is already gone.
      if (error instanceof ApiError && error.status === 404) {
        setUploads((current) => current.filter((item) => item.id !== upload.id));
        setActionSuccess(`${upload.filename} was already deleted.`);
      } else fail(error, setActionError);
    } finally {
      setPending(null);
    }
  }

  return <SettingsCard title="Your uploads"
    description="Files you attached to messages that haven't expired yet. Deleting one makes its link stop working."
    actions={<button className="button button-quiet button-small" type="button" onClick={() => void loadUploads()}
      disabled={loading || loadingMore || pending !== null}><Icon name="rotate" />Refresh</button>}>
    {(loading || error) && <div className="settings-row">
      {loading && <p className="settings-help" role="status">Loading uploads…</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>}
    {!loading && !error && !uploads.length && <div className="settings-row">
      <p className="settings-help">No uploads. Files you attach in the message box are listed here until they expire.</p>
    </div>}
    {uploads.length > 0 && <ul className="settings-list">{uploads.map((upload) => <li className="settings-list__item" key={upload.id}>
      <div className="settings-list__main">
        <span className="settings-list__title">{upload.filename}</span>
        <span className="settings-help upload-link">{upload.url}</span>
        <span className="settings-help">
          {formatBytes(upload.size)} · {expiryText(upload.expiresAt, now)} · Uploaded {new Date(upload.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="settings-list__actions">
        <button className="button button-quiet button-small" type="button" onClick={() => void copyLink(upload)}>
          {copied === upload.id ? <><Icon name="check" />Copied</> : 'Copy link'}
        </button>
        <button className="button button-danger button-small" type="button" disabled={pending !== null}
          onClick={() => void deleteUpload(upload)}>{pending === upload.id ? 'Deleting…' : 'Delete'}</button>
      </div>
    </li>)}</ul>}
    {hasMore && <div className="settings-row">
      <button className="button button-small" type="button" disabled={loading || loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? 'Loading…' : 'Load more'}
      </button>
    </div>}
    {(actionError || actionSuccess) && <div className="settings-row">
      <SettingsStatus error={actionError} success={actionSuccess} />
    </div>}
  </SettingsCard>;
}
