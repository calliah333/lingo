import { useEffect, useRef, useState } from 'react';
import type { ChannelListPage, ChannelListStatus, Network } from '../shared/contracts';
import { api, ApiError, errorText } from './api';

const PAGE_LIMIT = 500;

type ChannelListPanelProps = {
  network: Network;
  /** Latest pushed status; a change in `updatedAt` refetches the visible page. */
  status: ChannelListStatus | undefined;
  connected: boolean;
  isJoined: (name: string) => boolean;
  onJoin: (name: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

export default function ChannelListPanel({
  network, status, connected, isJoined, onJoin, onRefresh, onClose, onUnauthorized,
}: ChannelListPanelProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState<ChannelListPage | null>(null);
  const [error, setError] = useState('');
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (debouncedQuery) params.set('q', debouncedQuery);
    api<ChannelListPage>(`/api/networks/${network.id}/channels?${params}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage(result);
        setError('');
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) unauthorizedRef.current();
        setError(errorText(failure));
      });
    return () => controller.abort();
  }, [network.id, debouncedQuery, status?.state, status?.updatedAt]);

  const state = status?.state ?? page?.state ?? 'idle';
  const total = status?.total ?? page?.total ?? 0;
  const updatedAt = status?.updatedAt ?? page?.updatedAt ?? null;
  const summary = state === 'loading' ? `Loading… ${total.toLocaleString()} channels so far`
    : state === 'complete' ? `${total.toLocaleString()} channels${updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString()}` : ''}`
      : connected ? 'No channel list loaded yet.' : 'Connect to this network to list its channels.';

  return <section className="channel-list-panel" aria-label={`Channel list for ${network.name}`}>
    <header className="search-panel__header">
      <div>
        <span className="conversation-overline">{network.name} <span className="divider">/</span> channel list</span>
        <h2 className="search-panel__title">Channel list</h2>
      </div>
      <div className="conversation-actions">
        <button className="button button-quiet" type="button" onClick={onRefresh}
          disabled={!connected || state === 'loading'}>{state === 'idle' ? 'Load channels' : 'Refresh'}</button>
        <button className="search-panel__close" type="button" aria-label="Close channel list" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="channel-list-panel__controls">
      <label className="sr-only" htmlFor={`channel-list-filter-${network.id}`}>Filter channels by name or topic</label>
      <input id={`channel-list-filter-${network.id}`} type="search" value={query} autoComplete="off"
        placeholder="Filter by name or topic…" onChange={(event) => setQuery(event.target.value)} />
      <span className="channel-list-panel__summary" role="status">{summary}</span>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="channel-list-panel__results">
      {page && page.channels.length > 0 ? <table className="channel-list-table">
        <thead><tr><th scope="col">Channel</th><th scope="col">Users</th><th scope="col">Topic</th></tr></thead>
        <tbody>
          {page.channels.map((channel) => {
            const joined = isJoined(channel.name);
            return <tr key={channel.name}>
              <td>
                <button className="text-button channel-list-table__name" type="button"
                  title={joined ? `Open ${channel.name}` : `Join ${channel.name}`} onClick={() => onJoin(channel.name)}>
                  {channel.name}
                </button>
                {joined && <span className="channel-list-table__joined">joined</span>}
              </td>
              <td className="channel-list-table__users">{channel.users.toLocaleString()}</td>
              <td className="channel-list-table__topic" title={channel.topic}>{channel.topic}</td>
            </tr>;
          })}
        </tbody>
      </table> : page && state !== 'idle' && <p className="search-panel__status">
        {state === 'loading' ? 'Waiting for channels…' : debouncedQuery ? 'No matching channels.' : 'The server returned no channels.'}
      </p>}
      {page && page.matched > page.channels.length && <p className="search-panel__status">
        Showing the {page.channels.length.toLocaleString()} largest of {page.matched.toLocaleString()} matching channels. Refine the filter to see more.
      </p>}
    </div>
  </section>;
}
