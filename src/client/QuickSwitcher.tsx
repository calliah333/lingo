import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BufferUnread, ChatBuffer, Network, SyncedSettings } from '../shared/contracts';
import { fuzzyScore, orderedBuffers } from './chat';
import Icon from './Icon';

type QuickSwitcherProps = {
  networks: Network[];
  buffers: ChatBuffer[];
  unread: Record<number, BufferUnread>;
  settings: SyncedSettings;
  currentId: number | null;
  onSelect: (bufferId: number) => void;
  onClose: () => void;
};

type Result = { buffer: ChatBuffer; label: string; network: string; hidden: boolean; mentions: number; unread: boolean };

const maxResults = 50;

/**
 * Ctrl/Cmd+K: fuzzy-find a buffer by name or network. With no query it lists unread buffers (mentions first), then
 * the rest in sidebar order; a query also finds closed private conversations, which reopen when chosen.
 */
export default function QuickSwitcher({ networks, buffers, unread, settings, currentId, onSelect, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const chosen = useRef(false);
  const listId = useId();

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    // Choosing a buffer moves focus to its composer; only a dismissal returns focus to where it was.
    return () => { if (!chosen.current && previous instanceof HTMLElement) previous.focus(); };
  }, []);

  const results = useMemo<Result[]>(() => {
    const names = new Map(networks.map((network) => [network.id, network.name]));
    const everything = orderedBuffers(networks, buffers, { ...settings, hiddenBuffers: [] });
    const rows = everything.map((buffer, order) => {
      const network = names.get(buffer.networkId) ?? '';
      const muted = settings.mutedBuffers.includes(buffer.id) || settings.mutedNetworks.includes(buffer.networkId);
      const counts = muted ? undefined : unread[buffer.id];
      return {
        buffer, order, network,
        label: buffer.kind === 'server' ? network : buffer.name,
        hidden: settings.hiddenBuffers.includes(buffer.id),
        mentions: counts?.mentions ?? 0,
        unread: !!counts?.messages,
      };
    });
    const attention = (row: (typeof rows)[number]) => row.mentions ? 0 : row.unread ? 1 : 2;
    if (!query.trim()) {
      return rows.filter((row) => !row.hidden && row.buffer.id !== currentId)
        .sort((left, right) => attention(left) - attention(right) || left.order - right.order)
        .slice(0, maxResults);
    }
    return rows.flatMap((row) => {
      const scores = [
        fuzzyScore(query, row.label),
        fuzzyScore(query, `${row.label} ${row.network}`),
        fuzzyScore(query, `${row.network} ${row.label}`),
      ].filter((score): score is number => score !== null);
      return scores.length ? [{ row, score: Math.max(...scores) }] : [];
    }).sort((left, right) => right.score - left.score || Number(left.row.hidden) - Number(right.row.hidden)
      || attention(left.row) - attention(right.row) || left.row.order - right.row.order)
      .slice(0, maxResults).map(({ row }) => row);
  }, [networks, buffers, unread, settings, currentId, query]);

  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(result: Result | undefined) {
    if (!result) return;
    chosen.current = true;
    onSelect(result.buffer.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + step + results.length) % results.length);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(results[active]);
    }
  }

  return <div className="modal-scrim quick-switcher-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal quick-switcher" role="dialog" aria-modal="true" aria-label="Jump to a conversation">
      <div className="quick-switcher__field">
        <Icon name="search" />
        <input ref={inputRef} type="text" role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={results.length ? `${listId}-${active}` : undefined} autoComplete="off" spellCheck={false}
          placeholder="Jump to a channel or conversation" value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={onKeyDown} />
      </div>
      <ul className="quick-switcher__list" id={listId} role="listbox" aria-label="Conversations" ref={listRef}>
        {results.map((result, index) => <li key={result.buffer.id} role="presentation">
          <button type="button" id={`${listId}-${index}`} data-index={index} role="option" aria-selected={index === active}
            tabIndex={-1} className={`quick-switcher__option${result.unread ? ' is-unread' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (index !== active) setActiveIndex(index); }}
            onClick={() => choose(result)}>
            <Icon name={result.buffer.kind === 'server' ? 'server' : result.buffer.kind === 'channel' ? 'hash' : 'at'} />
            <span className="quick-switcher__name">
              {result.buffer.kind === 'channel' ? result.label.replace(/^#/, '') : result.label}
            </span>
            {result.buffer.kind !== 'server' && <span className="quick-switcher__network">{result.network}</span>}
            {result.hidden && <span className="quick-switcher__network">closed</span>}
            {result.mentions > 0
              ? <span className="badge badge-mention" aria-label={`${result.mentions} unread mentions`}>{result.mentions}</span>
              : result.unread && <span className="sr-only">, unread</span>}
          </button>
        </li>)}
        {!results.length && <li className="quick-switcher__empty">No matching conversations</li>}
      </ul>
    </section>
  </div>;
}
