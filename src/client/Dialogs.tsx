import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { BanEntry, ChatBuffer, Network, WhoisInfo } from '../shared/contracts';
import { api, ApiError, errorText, json } from './api';
import Icon from './Icon';

type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Receives focus on open instead of the close button. */
  initialFocusRef?: RefObject<HTMLElement | null>;
};

function Modal({ title, onClose, children, initialFocusRef }: ModalProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    (initialFocusRef?.current ?? closeRef.current)?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <div className="modal-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="modal__header">
        <h2 id={titleId}>{title}</h2>
        <button ref={closeRef} className="icon-button" type="button" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="modal__body">{children}</div>
    </section>
  </div>;
}

/** Loads once per mount; a 401 hands control back to the login screen. */
function useRequest<T>(load: (signal: AbortSignal) => Promise<T>, onUnauthorized: () => void) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const loadRef = useRef(load);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  useEffect(() => {
    const controller = new AbortController();
    loadRef.current(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ data, error: '', loading: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) unauthorizedRef.current();
      setState({ data: null, error: errorText(error), loading: false });
    });
    return () => controller.abort();
  }, []);
  return state;
}

function duration(seconds: number): string {
  const units: Array<[string, number]> = [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]];
  const parts: string[] = [];
  let remaining = Math.floor(seconds);
  for (const [unit, size] of units) {
    if (remaining >= size || (unit === 's' && !parts.length)) {
      parts.push(`${Math.floor(remaining / size)}${unit}`);
      remaining %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

type WhoisDialogProps = {
  network: Network;
  nick: string;
  onClose: () => void;
  onMessage: (nick: string) => void;
  onUnauthorized: () => void;
};

export function WhoisDialog({ network, nick, onClose, onMessage, onUnauthorized }: WhoisDialogProps) {
  const { data, error, loading } = useRequest((signal) =>
    api<WhoisInfo>(`/api/networks/${network.id}/whois`, { ...json('POST', { nick }), signal }), onUnauthorized);
  const rows: Array<[string, string | undefined]> = data?.found ? [
    ['Address', data.ident && data.hostname ? `${data.ident}@${data.hostname}` : data.hostname],
    ['Real name', data.realName],
    ['Account', data.account],
    ['Channels', data.channels],
    ['Server', data.server && (data.serverInfo ? `${data.server} — ${data.serverInfo}` : data.server)],
    ['Away', data.away],
    ['Operator', data.operator],
    ['Connection', data.secure ? 'Secure (TLS)' : undefined],
    ['Idle', data.idleSeconds === undefined ? undefined : duration(data.idleSeconds)],
    ['Signed on', data.signonTime === undefined ? undefined : new Date(data.signonTime).toLocaleString()],
  ] : [];
  return <Modal title={`User info · ${data?.nick ?? nick}`} onClose={onClose}>
    {loading ? <p className="modal__status" role="status">Looking up <span className="modal__mono">{nick}</span> on {network.name}…</p>
      : error ? <p className="error-text" role="alert">{error}</p>
        : !data?.found ? <p className="modal__status"><span className="modal__mono">{nick}</span> is not online on {network.name}.</p>
          : <dl className="modal__facts">
            {rows.filter((row): row is [string, string] => !!row[1]).map(([label, value]) => <div key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}
          </dl>}
    <div className="modal__actions">
      <button className="button button-quiet" type="button" onClick={onClose}>Close</button>
      <button className="button button-primary" type="button" onClick={() => { onClose(); onMessage(data?.nick ?? nick); }}>
        <Icon name="message" />Direct message
      </button>
    </div>
  </Modal>;
}

type BanListDialogProps = { buffer: ChatBuffer; onClose: () => void; onUnauthorized: () => void };

export function BanListDialog({ buffer, onClose, onUnauthorized }: BanListDialogProps) {
  const { data, error, loading } = useRequest((signal) =>
    api<{ bans: BanEntry[] }>(`/api/buffers/${buffer.id}/bans`, { method: 'POST', signal }), onUnauthorized);
  return <Modal title={`Bans · ${buffer.name}`} onClose={onClose}>
    {loading ? <p className="modal__status" role="status">Loading ban list…</p>
      : error ? <p className="error-text" role="alert">{error}</p>
        : !data?.bans.length ? <p className="modal__status">No bans are set on <span className="modal__mono">{buffer.name}</span>.</p>
          : <ul className="modal__list">
            {data.bans.map((ban) => <li key={ban.mask}>
              <code className="modal__mono">{ban.mask}</code>
              <span className="modal__meta">
                {ban.setBy && `by ${ban.setBy}`}{ban.setAt !== null && ` · ${new Date(ban.setAt).toLocaleString()}`}
              </span>
            </li>)}
          </ul>}
  </Modal>;
}

type IgnoreListDialogProps = {
  network: Network;
  ignores: string[];
  onChange: (ignores: string[]) => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

export function IgnoreListDialog({ network, ignores, onChange, onClose, onUnauthorized }: IgnoreListDialogProps) {
  const [nick, setNick] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function update(target: string, ignored: boolean) {
    setPending(true);
    setError('');
    try {
      const result = await api<{ ignores: string[] }>(`/api/networks/${network.id}/ignores`,
        json(ignored ? 'POST' : 'DELETE', { nick: target }));
      onChange(result.ignores);
      if (ignored) setNick('');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      setError(errorText(failure));
    } finally {
      setPending(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (nick.trim()) void update(nick.trim(), true);
  }

  return <Modal title={`Ignored users · ${network.name}`} onClose={onClose}>
    {ignores.length ? <ul className="modal__list">
      {ignores.map((ignored) => <li key={ignored}>
        <span className="modal__mono">{ignored}</span>
        <button className="button button-quiet button-small" type="button" disabled={pending}
          onClick={() => void update(ignored, false)}>Unignore</button>
      </li>)}
    </ul> : <p className="modal__status">No ignored users on {network.name}.</p>}
    <form className="modal__form" onSubmit={add}>
      <label className="sr-only" htmlFor="ignore-nick">Nickname to ignore</label>
      <input id="ignore-nick" className="modal__mono" value={nick} onChange={(event) => setNick(event.target.value)}
        placeholder="nickname" autoComplete="off" spellCheck={false} maxLength={64} disabled={pending} />
      <button className="button button-primary" type="submit" disabled={pending || !/^[^\s,:]+$/.test(nick.trim())}>Ignore</button>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
  </Modal>;
}

type DisplayNameDialogProps = {
  network: Network;
  nick: string;
  initial: string;
  onSave: (displayName: string) => Promise<void>;
  onClose: () => void;
};

/** Edits one nickname's display-name override; stays open with the error when saving fails. */
export function DisplayNameDialog({ network, nick, initial, onSave, onClose }: DisplayNameDialogProps) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const helpId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await onSave(value.trim());
    } catch (failure) {
      setError(errorText(failure));
      setPending(false);
      inputRef.current?.focus();
      return;
    }
    onClose();
  }

  return <Modal title="Display name" onClose={onClose} initialFocusRef={inputRef}>
    <form className="modal__fields" onSubmit={(event) => void submit(event)}>
      <label className="modal__label" htmlFor={inputId}>
        Display name for <span className="modal__mono">{nick}</span> on {network.name}
      </label>
      <input ref={inputRef} id={inputId} value={value} maxLength={64} autoComplete="off" spellCheck={false}
        placeholder={nick} aria-describedby={helpId} aria-invalid={error ? true : undefined} readOnly={pending}
        onChange={(event) => { setValue(event.target.value); setError(''); }}
        onFocus={(event) => event.currentTarget.select()} />
      <p className="modal__help" id={helpId}>
        Shown instead of the nickname in this network's transcript. Leave blank to show the nickname.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal__actions">
        <button className="button button-quiet" type="button" onClick={onClose} disabled={pending}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </Modal>;
}

type ExportDialogProps = { network: Network; buffer: ChatBuffer | null; onClose: () => void };

const exportFormats = [
  { value: 'txt', label: 'Plain text', help: 'One readable line per message, without colors or formatting.' },
  { value: 'jsonl', label: 'JSON Lines', help: 'One JSON message per line, for scripts and other tools.' },
] as const;

/** Downloads a buffer's history as text or JSONL, or a whole network's history as JSONL. */
export function ExportDialog({ network, buffer, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<'txt' | 'jsonl'>(buffer ? 'txt' : 'jsonl');
  const downloadRef = useRef<HTMLAnchorElement>(null);
  const name = useId();
  const href = buffer
    ? `/api/buffers/${buffer.id}/export?format=${format}`
    : `/api/networks/${network.id}/export?format=jsonl`;

  return <Modal title={`Export history · ${buffer?.name ?? network.name}`} onClose={onClose} initialFocusRef={downloadRef}>
    {buffer ? <div className="modal__fields" role="radiogroup" aria-label="Format">
      {exportFormats.map((option) => <label key={option.value} className="modal__choice">
        <input type="radio" name={name} value={option.value} checked={format === option.value}
          onChange={() => setFormat(option.value)} />
        <span><strong>{option.label}</strong> <span className="modal__help">{option.help}</span></span>
      </label>)}
    </div> : <p className="modal__status">
      Every conversation on {network.name}, as JSON Lines: one message per line, each with its conversation name.
    </p>}
    <div className="modal__actions">
      <button className="button button-quiet" type="button" onClick={onClose}>Cancel</button>
      {/* Closing on the next task leaves the link connected until the browser has started the download. */}
      <a ref={downloadRef} className="button button-primary" href={href} download onClick={() => setTimeout(onClose)}>
        <Icon name="download" />Download
      </a>
    </div>
  </Modal>;
}
