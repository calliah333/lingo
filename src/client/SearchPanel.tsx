import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { displayIdentity } from '../shared/identity';
import type { ChatBuffer, ChatMessage, Network } from '../shared/contracts';
import Icon from './Icon';
import PaneHeader from './PaneHeader';

type SearchResponse = {
  messages: ChatMessage[];
  hasMore: boolean;
};
const TIME_RANGES = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
} as const;

type SearchPanelProps = {
  networks: Network[];
  initialBufferId?: number;
  buffers: ChatBuffer[];
  onClose: () => void;
  onJump: (message: ChatMessage) => void;
};

/** Wraps case-insensitive occurrences of the query's words in <mark>; `pattern` must have one capturing group. */
function emphasize(text: string, pattern: RegExp | null): ReactNode {
  if (!pattern) return text;
  return text.split(pattern).map((part, index) => index % 2 ? <mark key={index} className="search-result__match">{part}</mark> : part);
}

export default function SearchPanel({ networks, buffers, initialBufferId, onClose, onJump }: SearchPanelProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [networkId, setNetworkId] = useState(() => {
    const buffer = buffers.find((item) => item.id === initialBufferId);
    return buffer ? String(buffer.networkId) : '';
  });
  const [bufferId, setBufferId] = useState(() =>
    buffers.some((buffer) => buffer.id === initialBufferId) ? String(initialBufferId) : '',
  );
  const [timeScope, setTimeScope] = useState<'any' | keyof typeof TIME_RANGES>('any');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const boundsRef = useRef<{ since: number; until: number } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => resultsRef.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => messages[index]?.id ?? index,
  });
  const resetResults = () => {
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    boundsRef.current = null;
    loadingMore.current = false;
    setMessages([]);
    setHasMore(false);
    setError('');
    setLoading(false);
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  };
  useEffect(() => () => {
    requestId.current += 1;
    activeRequest.current?.abort();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (!query || query !== input.trim()) return;

    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    const currentRequest = ++requestId.current;
    const params = new URLSearchParams({ q: query, limit: '50' });
    if (networkId) params.set('networkId', networkId);
    if (bufferId) params.set('bufferId', bufferId);
    let bounds: { since: number; until: number } | null = null;
    if (timeScope !== 'any') {
      const until = Date.now();
      bounds = { since: until - TIME_RANGES[timeScope], until };
      params.set('since', String(bounds.since));
      params.set('until', String(bounds.until));
    }
    boundsRef.current = bounds;
    setMessages([]);
    setHasMore(false);
    setError('');
    setLoading(true);
    void fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        return (await response.json()) as SearchResponse;
      })
      .then((result) => {
        if (requestId.current !== currentRequest) return;
        setMessages(result.messages);
        setHasMore(result.hasMore);
      })
      .catch((reason: unknown) => {
        if (requestId.current !== currentRequest || controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Search failed');
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });

    return () => controller.abort();
  }, [query, input, networkId, bufferId, timeScope]);
  const loadMore = async () => {
    const lastMessage = messages[messages.length - 1];
    if (!query || !hasMore || !lastMessage || loading || loadingMore.current) return;
    loadingMore.current = true;

    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const currentRequest = ++requestId.current;
    const params = new URLSearchParams({ q: query, before: String(lastMessage.id), limit: '50' });
    if (networkId) params.set('networkId', networkId);
    if (bufferId) params.set('bufferId', bufferId);
    const bounds = boundsRef.current;
    if (bounds) {
      params.set('since', String(bounds.since));
      params.set('until', String(bounds.until));
    }
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/search?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Search failed (${response.status})`);
      const result = (await response.json()) as SearchResponse;
      if (requestId.current !== currentRequest) return;
      setMessages((current) => [...current, ...result.messages]);
      setHasMore(result.hasMore);
    } catch (reason) {
      if (requestId.current === currentRequest && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Search failed');
      }
    } finally {
      if (requestId.current === currentRequest) {
        loadingMore.current = false;
        setLoading(false);
      }
    }
  };

  const networkById = useMemo(() => new Map(networks.map((network) => [network.id, network])), [networks]);
  const bufferById = useMemo(() => new Map(buffers.map((buffer) => [buffer.id, buffer])), [buffers]);
  const filteredBuffers = useMemo(
    () => networkId ? buffers.filter((buffer) => String(buffer.networkId) === networkId) : buffers,
    [buffers, networkId],
  );
  const matchPattern = useMemo(() => {
    // The server matches the input as one literal FTS phrase of whole words; emphasize those words, longest first.
    const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].sort((a, b) => b.length - a.length);
    return terms.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${terms.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  }, [query]);

  return (
    <section className="search-view" aria-label="Search history">
      <PaneHeader title="Search" actions={
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close search" title="Close">
          <Icon name="x" />
        </button>} />
      <div className="search-view__controls">
        <div className="search-view__column">
          <label className="search-field">
            <span className="sr-only">Search messages</span>
            <Icon name="search" className="search-field__icon" />
            <input
              className="search-panel__query search-field__input"
              type="search"
              value={input}
              onChange={(event) => {
                resetResults();
                setInput(event.target.value);
              }}
              placeholder="Search message history"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <div className="search-filters">
            <label className="search-filter">
              <span className="search-filter__label">Network</span>
              <select
                value={networkId}
                onChange={(event) => {
                  resetResults();
                  setNetworkId(event.target.value);
                  setBufferId('');
                }}
              >
                <option value="">All networks</option>
                {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
              </select>
            </label>
            <label className="search-filter">
              <span className="search-filter__label">Channel or buffer</span>
              <select
                value={bufferId}
                onChange={(event) => {
                  resetResults();
                  setBufferId(event.target.value);
                }}
              >
                <option value="">All channels and buffers</option>
                {filteredBuffers.map((buffer) => {
                  const name = buffer.kind === 'server' ? 'Server messages' : buffer.name;
                  return <option key={buffer.id} value={buffer.id}>
                    {networkId ? name : `${networkById.get(buffer.networkId)?.name ?? 'Network'} · ${name}`}
                  </option>;
                })}
              </select>
            </label>
            <label className="search-filter">
              <span className="search-filter__label">Time</span>
              <select
                value={timeScope}
                onChange={(event) => {
                  resetResults();
                  setTimeScope(event.target.value as typeof timeScope);
                }}
              >
                <option value="any">Any time</option>
                <option value="day">Past day</option>
                <option value="week">Past week</option>
                <option value="month">Past month</option>
              </select>
            </label>
          </div>
        </div>
      </div>
      <div className="pane-body search-results" ref={resultsRef} aria-live="polite" aria-busy={loading}>
        <div className="search-view__column">
          {!input.trim() && <div className="empty-state">
            <Icon name="search" className="empty-state__icon" />
            <p>Enter a search phrase to find stored messages.</p>
          </div>}
          {input.trim() && query !== input.trim() && <p className="search-results__status">Waiting to search…</p>}
          {!loading && !error && query && query === input.trim() && messages.length === 0
            && <p className="search-results__status">No matching messages.</p>}
          {messages.length > 0 && (
            <ol className="search-results__list" style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((row) => {
                const message = messages[row.index]!;
                const buffer = bufferById.get(message.bufferId);
                const network = networkById.get(message.networkId);
                const identity = displayIdentity(message, network?.relayNicks ?? [], network?.displayNames);
                return (
                  <li
                    className="search-results__item"
                    key={row.key}
                    data-index={row.index}
                    ref={rowVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
                  >
                    <button className="search-result" type="button" onClick={() => onJump(message)}>
                      <span className="search-result__context">
                        <span className="search-result__network">{network?.name ?? 'Unknown network'}</span>
                        <span className="search-result__divider" aria-hidden="true">·</span>
                        <span className="search-result__buffer">
                          {!buffer ? 'Unknown buffer' : buffer.kind === 'server' ? 'Server messages' : buffer.name}
                        </span>
                        <span className="search-result__divider" aria-hidden="true">·</span>
                        <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleString()}</time>
                      </span>
                      <span className="search-result__message">
                        {identity.nick && <span className="search-result__nick">{identity.nick}</span>}
                        <span className="search-result__text">{emphasize(identity.text, matchPattern)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {loading && <p className="search-results__status">Searching…</p>}
          {error && <p className="error-text search-results__error" role="alert">{error}</p>}
          {hasMore && (
            <div className="search-results__more">
              <button className="button" type="button" onClick={() => void loadMore()} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
