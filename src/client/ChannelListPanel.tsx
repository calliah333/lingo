import { useEffect, useRef, useState } from 'react';
import type { ChannelListPage, ChannelListStatus, Network } from '../shared/contracts';
import { api, ApiError, errorText } from './api';
import Icon from './Icon';
import PaneHeader from './PaneHeader';

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
      : '';

  return <section className="channel-list-view" aria-label={`Channel list for ${network.name}`}>
    <PaneHeader overline={network.name} title="Channel list" actions={<>
      {state !== 'idle' && <button className="button button-small" type="button" onClick={onRefresh}
        disabled={!connected || state === 'loading'}>
        <Icon name="rotate" />Refresh
      </button>}
      <button className="icon-button" type="button" aria-label="Close channel list" title="Close" onClick={onClose}>
        <Icon name="x" />
      </button>
    </>} />
    <div className="channel-list-view__toolbar">
      <div className="channel-list-view__column">
        <div className="channel-list-view__filter">
          <Icon name="search" className="channel-list-view__filter-icon" />
          <label className="sr-only" htmlFor={`channel-list-filter-${network.id}`}>Filter channels by name or topic</label>
          <input id={`channel-list-filter-${network.id}`} type="search" value={query} autoComplete="off" spellCheck={false}
            placeholder="Filter by name or topic…" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <span className="channel-list-view__summary" role="status">
          {state === 'loading' && <span className="status-dot status-connecting" aria-hidden="true" />}
          {summary}
        </span>
      </div>
    </div>
    <div className="pane-body channel-list-view__results">
      <div className="channel-list-view__column">
        {error && <p className="error-text channel-list-view__error" role="alert">{error}</p>}
        {state === 'idle' && <div className="empty-state">
          <Icon name="list" className="empty-state__icon" />
          <p>{connected ? `Load the channels on ${network.name} to browse and join them.`
            : 'Connect to this network to list its channels.'}</p>
          {connected && <button className="button button-primary" type="button" onClick={onRefresh}>Load channels</button>}
        </div>}
        {page && page.channels.length > 0 ? <table className="channel-list-table">
          <thead><tr>
            <th scope="col">Channel</th>
            <th scope="col" className="channel-list-table__users">Users</th>
            <th scope="col" className="channel-list-table__topic">Topic</th>
            <th scope="col" className="channel-list-table__action"><span className="sr-only">Action</span></th>
          </tr></thead>
          <tbody>
            {page.channels.map((channel) => {
              const joined = isJoined(channel.name);
              return <tr key={channel.name}>
                <td className="channel-list-table__channel">
                  <span className="channel-list-table__name">{channel.name}</span>
                  {joined && <span className="badge badge-accent channel-list-table__joined">joined</span>}
                  {channel.topic && <span className="channel-list-table__topic-inline">{channel.topic}</span>}
                </td>
                <td className="channel-list-table__users">{channel.users.toLocaleString()}</td>
                <td className="channel-list-table__topic" title={channel.topic}>{channel.topic}</td>
                <td className="channel-list-table__action">
                  <button className={joined ? 'button button-small button-quiet' : 'button button-small'} type="button"
                    aria-label={joined ? `Open ${channel.name}` : `Join ${channel.name}`} onClick={() => onJoin(channel.name)}>
                    {joined ? 'Open' : 'Join'}
                  </button>
                </td>
              </tr>;
            })}
          </tbody>
        </table> : page && state !== 'idle' && <p className="channel-list-view__status">
          {state === 'loading' ? 'Waiting for channels…' : debouncedQuery ? 'No matching channels.' : 'The server returned no channels.'}
        </p>}
        {page && page.matched > page.channels.length && <p className="channel-list-view__status">
          Showing the {page.channels.length.toLocaleString()} largest of {page.matched.toLocaleString()} matching channels. Refine the filter to see more.
        </p>}
      </div>
    </div>
  </section>;
}
