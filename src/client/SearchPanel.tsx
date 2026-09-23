import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { displayIdentity } from '../shared/identity';
import type { ChatBuffer, ChatMessage, Network } from '../shared/contracts';

type SearchResponse = {
  messages: ChatMessage[];
  hasMore: boolean;
};

type SearchPanelProps = {
  networks: Network[];
  buffers: ChatBuffer[];
  onClose: () => void;
  onJump: (message: ChatMessage) => void;
};

export default function SearchPanel({ networks, buffers, onClose, onJump }: SearchPanelProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [networkId, setNetworkId] = useState('');
  const [bufferId, setBufferId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => resultsRef.current,
    estimateSize: () => 84,
    overscan: 6,
    getItemKey: (index) => messages[index]?.id ?? index,
  });
  const resetResults = () => {
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
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
    if (!query) {
      setMessages([]);
      setHasMore(false);
      setLoading(false);
      setError('');
      return;
    }

    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    const currentRequest = ++requestId.current;
    const params = new URLSearchParams({ q: query, limit: '50' });
    if (networkId) params.set('networkId', networkId);
    if (bufferId) params.set('bufferId', bufferId);

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
  }, [query, networkId, bufferId]);
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
  const networkNames = useMemo(() => new Map(networks.map((network) => [network.id, network.name])), [networks]);
  const bufferById = useMemo(() => new Map(buffers.map((buffer) => [buffer.id, buffer])), [buffers]);
  const filteredBuffers = useMemo(
    () => networkId ? buffers.filter((buffer) => String(buffer.networkId) === networkId) : buffers,
    [buffers, networkId],
  );

  return (
    <section className="search-panel" aria-label="Search history">
      <header className="search-panel__header">
        <h2 className="search-panel__title">Search history</h2>
        <button className="search-panel__close" type="button" onClick={onClose} aria-label="Close search">×</button>
      </header>
      <div className="search-panel__controls">
        <label className="search-panel__query-label">
          <span>Search messages</span>
          <input
            className="search-panel__query"
            type="search"
            value={input}
            onChange={(event) => {
              resetResults();
              setInput(event.target.value);
            }}
            placeholder="Search history"
            autoFocus
          />
        </label>
        <label className="search-panel__filter-label">
          <span>Network</span>
          <select
            className="search-panel__filter"
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
        <label className="search-panel__filter-label">
          <span>Channel or buffer</span>
          <select
            className="search-panel__filter"
            value={bufferId}
            onChange={(event) => {
              resetResults();
              setBufferId(event.target.value);
            }}
          >
            <option value="">All channels and buffers</option>
            {filteredBuffers.map((buffer) => (
              <option key={buffer.id} value={buffer.id}>
                {networkNames.get(buffer.networkId) ?? 'Network'} · {buffer.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="search-panel__results" ref={resultsRef} aria-live="polite" aria-busy={loading}>
        {!input.trim() && <p className="search-panel__status">Enter a search phrase to find stored messages.</p>}
        {input.trim() && query !== input.trim() && <p className="search-panel__status">Waiting to search…</p>}
        {!loading && !error && query && messages.length === 0 && <p className="search-panel__status">No matching messages.</p>}
        {messages.length > 0 && (
          <ol className="search-panel__list" style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((row) => {
              const message = messages[row.index]!;
              const buffer = bufferById.get(message.bufferId);
              const network = networkById.get(message.networkId);
              const identity = displayIdentity(message, network?.relayNicks ?? [], network?.displayNames);
              return (
                <li
                  className="search-panel__item"
                  key={row.key}
                  data-index={row.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
                >
                  <button className="search-panel__result" type="button" onClick={() => onJump(message)}>
                    <span className="search-panel__context">
                      <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleString()}</time>
                      <span>{network?.name ?? 'Unknown network'}</span>
                      <span>{buffer?.name ?? 'Unknown buffer'}</span>
                      {identity.nick && <span>{identity.nick}</span>}
                    </span>
                    <span className="search-panel__text">{identity.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {loading && <p className="search-panel__status">Searching…</p>}
        {error && <p className="search-panel__error" role="alert">{error}</p>}
        {hasMore && (
          <button className="search-panel__more" type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
}
