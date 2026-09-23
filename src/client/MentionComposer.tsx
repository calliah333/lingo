import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import type { ChatBuffer, MentionCandidate } from '../shared/contracts';

type MentionComposerProps = {
  buffer: ChatBuffer;
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
};

type MentionContext = { start: number; end: number; query: string };

function mentionContext(value: string, caret: number): MentionContext | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|[\s([{])@([^\s@]*)$/.exec(beforeCaret);
  if (!match) return null;
  const query = match[1];
  const start = caret - query.length - 1;
  return { start, end: caret, query };
}

export default function MentionComposer({ buffer, disabled, onSend, onError }: MentionComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const context = mentionContext(value, caret);
  const menuOpen = !!context && !dismissed && !disabled;
  const listId = `mention-options-${buffer.id}`;
  const activeOptionId = menuOpen && candidates.length ? `${listId}-${activeIndex}` : undefined;

  const filtered = useMemo(() => {
    if (!context) return [];
    const query = context.query.toLocaleLowerCase();
    return candidates.filter((candidate) => candidate.name.toLocaleLowerCase().includes(query)
      || candidate.mention.toLocaleLowerCase().includes(query));
  }, [candidates, context?.query]);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!menuOpen) {
      setActiveIndex(0);
      return;
    }
    const controller = new AbortController();
    setCandidates([]);
    setLoading(true);
    setActiveIndex(0);
    void fetch(`/api/buffers/${buffer.id}/participants`, {
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `Could not load participants (${response.status})`;
        throw new Error(message);
      }
      return response.json() as Promise<{ participants: MentionCandidate[] }>;
    }).then((body) => {
      if (!Array.isArray(body?.participants)) throw new Error('Invalid participants response');
      setCandidates(body.participants.filter((candidate): candidate is MentionCandidate =>
        !!candidate && typeof candidate.name === 'string' && typeof candidate.mention === 'string'));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) onErrorRef.current(error);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [buffer.id, menuOpen]);

  useEffect(() => {
    setValue('');
    setCaret(0);
    setCandidates([]);
    setDismissed(false);
  }, [buffer.id]);

  useEffect(() => {
    setActiveIndex(0);
  }, [context?.query]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const position = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(position, position);
  }, [value]);

  function updateCaret(input: HTMLInputElement) {
    if (input.selectionStart !== input.selectionEnd) return;
    setCaret(input.selectionStart ?? input.value.length);
  }
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.currentTarget.value);
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
    setDismissed(false);
  }

  function choose(candidate: MentionCandidate) {
    if (!context) return;
    const insertion = `@${candidate.mention} `;
    const next = value.slice(0, context.start) + insertion + value.slice(context.end);
    const nextCaret = context.start + insertion.length;
    setValue(next);
    setCaret(nextCaret);
    pendingCaret.current = nextCaret;
    setDismissed(true);
    inputRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (menuOpen) {
      if (filtered.length) choose(filtered[Math.min(activeIndex, filtered.length - 1)]);
      return;
    }
    const text = value.trim();
    if (disabled || sendingRef.current || !text) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend(text);
      setValue('');
      setCaret(0);
      setDismissed(false);
    } catch (error) {
      onError(error);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (menuOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      if (filtered.length && event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % filtered.length);
        return;
      }
      if (filtered.length && event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
        return;
      }
      if (filtered.length && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault();
        choose(filtered[Math.min(activeIndex, filtered.length - 1)]);
      }
    }
  }

  return <form className="composer" onSubmit={submit}>
    <span className="composer-prompt" aria-hidden="true">›</span>
    <label className="sr-only" htmlFor={`message-input-${buffer.id}`}>Message to {buffer.name}</label>
    <input
      id={`message-input-${buffer.id}`}
      ref={inputRef}
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={activeOptionId}
      autoComplete="off"
      value={value}
      onChange={handleChange}
      onClick={(event) => updateCaret(event.currentTarget)}
      onKeyUp={(event) => updateCaret(event.currentTarget)}
      onKeyDown={handleKeyDown}
      placeholder={buffer.kind === 'server' ? 'Type a command…' : `Message ${buffer.name} or /command…`}
      disabled={disabled || sending}
    />
    {menuOpen && <ul id={listId} className="mention-menu" role="listbox" aria-label="Mention participants" aria-busy={loading}>
      {filtered.map((candidate, index) => <li key={`${candidate.mention.toLocaleLowerCase()}-${index}`} role="presentation">
        <button
          id={`${listId}-${index}`}
          className="mention-option"
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(candidate)}
        >
          {candidate.name}{candidate.name === candidate.mention ? '' : ` (@${candidate.mention})`}
        </button>
      </li>)}
      {!filtered.length && <li className="mention-option" role="option" aria-selected="false">{loading ? 'Loading participants…' : 'No matching participants'}</li>}
    </ul>}
    <button className="button button-primary send-button" type="submit" disabled={disabled || sending || !value.trim()}>
      {sending ? 'Sending…' : 'Send ↵'}
    </button>
  </form>;
}

