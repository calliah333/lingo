import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatBuffer, ChatMessage, Network } from '../shared/contracts';
import { displayIdentity, mentionRanges } from '../shared/identity';
import { nicknameColor } from './nickColor';
import type { AppPreferences } from './preferences';
import type { Theme } from './ThemePicker';

type TranscriptProps = {
  buffer: ChatBuffer;
  network: Network;
  messages: ChatMessage[];
  ownNames: string[];
  loading: boolean;
  hasMore: boolean;
  olderPending: boolean;
  error: string;
  jumpId: number | null;
  onLoadOlder: () => Promise<void>;
  onRetry: () => void;
  onRename: (mentionTarget: string, displayName: string) => void;
  /** Opens user actions for the IRC nick behind a message (the relayed nick for bridged users). */
  onNickMenu: (nick: string, x: number, y: number) => void;
  preferences: AppPreferences;
  theme: Theme;
};

type TranscriptRow =
  | { type: 'date'; key: string; date: Date }
  | { type: 'message'; key: string; message: ChatMessage };

type Anchor = { id: number; top: number };

function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateTimeLabel(time: number): string | undefined {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function Transcript({
  buffer,
  network,
  messages,
  ownNames,
  loading,
  hasMore,
  olderPending,
  error,
  jumpId,
  onLoadOlder,
  onRetry,
  onRename,
  onNickMenu,
  preferences,
  theme,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const pendingAnchorRef = useRef<Anchor | null>(null);
  const atBottomRef = useRef(true);
  const previousRef = useRef({ bufferId: buffer.id, messages, rows: [] as TranscriptRow[], hasMore });
  const requestedOldestRef = useRef<string | null>(null);
  const lastJumpRef = useRef<number | null>(null);
  const scrollReadyRef = useRef(false);
  const suppressTopScrollRef = useRef(false);
  const pendingJumpRef = useRef<number | null>(null);
  const anchorCorrectionFrameRef = useRef<number | null>(null);
  const olderRequestFrameRef = useRef<number | null>(null);
  const currentBufferIdRef = useRef(buffer.id);
  const relayNicks = network.relayNicks ?? [];
  const displayNames = network.displayNames ?? {};
  const ownNamesKey = ownNames.join('\u0000');
  const normalizedOwnNames = useMemo(() => ownNames.filter(Boolean), [ownNamesKey]);
  const highlightsKey = preferences.highlights.join('\u0000');
  const highlights = useMemo(() => preferences.highlights.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean), [highlightsKey]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', ...(preferences.showSeconds ? { second: '2-digit' } : {}),
    hour12: preferences.twelveHour,
  }), [preferences.showSeconds, preferences.twelveHour]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }), []);
  const rows = useMemo(() => {
    const result: TranscriptRow[] = [];
    let previousDay: string | null = null;
    for (const message of messages) {
      if (message.isMotd && !preferences.showMotd) continue;
      if (message.kind === 'system' && !message.connectionEvent && !message.fromNetwork
        && preferences.statusMessages === 'hidden') continue;
      const day = localDay(message.time);
      if (day !== previousDay && !Number.isNaN(message.time)) {
        result.push({ type: 'date', key: `date:${message.id}`, date: new Date(message.time) });
        previousDay = day;
      }
      result.push({ type: 'message', key: `message:${message.id}`, message });
    }
    return result;
  }, [messages, preferences.showMotd, preferences.statusMessages]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.type === 'date' ? 32 : rows[index]?.message.connectionEvent ? 30 : 26,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  currentBufferIdRef.current = buffer.id;

  function captureAnchor(): void {
    const element = scrollRef.current;
    if (!element || pendingAnchorRef.current) return;
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    const top = element.getBoundingClientRect().top;
    const visibleMessages = element.querySelectorAll<HTMLElement>('[data-message-id][data-index]');
    for (const node of visibleMessages) {
      const bounds = node.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= top + element.clientHeight) continue;
      const id = Number(node.dataset.messageId);
      if (!Number.isFinite(id)) continue;
      anchorRef.current = { id, top: node.getBoundingClientRect().top - top };
      break;
    }
  }

  function restoreAnchor(anchor: Anchor, forcePosition = false): void {
    const element = scrollRef.current;
    if (!element) return;
    const index = rows.findIndex((row) => row.type === 'message' && row.message.id === anchor.id);
    if (index < 0) return;
    const node = element.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
    if (!forcePosition && node && Number(node.dataset.index) === index) {
      element.scrollTop += node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.top;
    } else {
      pendingAnchorRef.current = anchor;
      virtualizer.scrollToIndex(index, { align: 'start' });
    }
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = previousRef.current;
    const changedBuffer = previous.bufferId !== buffer.id;
    const oldMessages = previous.messages;
    previousRef.current = { bufferId: buffer.id, messages, rows, hasMore };
    if (changedBuffer) {
      scrollReadyRef.current = false;
      atBottomRef.current = true;
      anchorRef.current = null;
      pendingAnchorRef.current = null;
      requestedOldestRef.current = null;
      lastJumpRef.current = null;
    }

    if (jumpId !== null && jumpId !== lastJumpRef.current) {
      const index = rows.findIndex((row) => row.type === 'message' && row.message.id === jumpId);
      if (index !== -1) {
        scrollReadyRef.current = false;
        pendingJumpRef.current = jumpId;
        pendingAnchorRef.current = null;
        virtualizer.scrollToIndex(index, { align: 'center' });
        lastJumpRef.current = jumpId;
        return;
      }
    }

    const oldFirstId = oldMessages[0]?.id;
    const prepended = !changedBuffer && oldFirstId !== undefined
      && messages.findIndex((message) => message.id === oldFirstId) > 0;
    if (prepended) {
      const anchor = anchorRef.current;
      if (anchor) restoreAnchor(anchor, true);
      else {
        const index = rows.findIndex((row) => row.type === 'message' && row.message.id === oldFirstId);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
      }
      suppressTopScrollRef.current = true;
      atBottomRef.current = false;
      return;
    }

    const appended = !changedBuffer && oldMessages.length > 0 && messages.length > oldMessages.length
      && oldMessages.every((message, index) => messages[index]?.id === message.id);
    if (changedBuffer || appended && atBottomRef.current || oldMessages.length === 0 && messages.length > 0 && atBottomRef.current
      || !scrollReadyRef.current && messages.length > 0) {
      const previousScrollTop = element.scrollTop;
      if (rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
      element.scrollTop = element.scrollHeight;
      if (element.scrollTop !== previousScrollTop) suppressTopScrollRef.current = true;
      scrollReadyRef.current = rows.length > 0;
    } else if (!atBottomRef.current && (previous.hasMore !== hasMore || previous.rows !== rows) && anchorRef.current) {
      restoreAnchor(anchorRef.current);
    }
  }, [buffer.id, messages, rows, hasMore, jumpId, virtualizer]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const jumpId = pendingJumpRef.current;
    if (jumpId !== null && element.querySelector(`[data-message-id="${jumpId}"]`)) {
      pendingJumpRef.current = null;
      scrollReadyRef.current = true;
    }
    const anchor = pendingAnchorRef.current;
    if (!anchor || anchorCorrectionFrameRef.current !== null) return;
    const correctAnchor = (framesRemaining: number) => {
      const element = scrollRef.current;
      const currentAnchor = pendingAnchorRef.current;
      if (!element || !currentAnchor) {
        anchorCorrectionFrameRef.current = null;
        return;
      }
      const index = rows.findIndex((row) => row.type === 'message' && row.message.id === currentAnchor.id);
      const node = element.querySelector<HTMLElement>(`[data-message-id="${currentAnchor.id}"]`);
      if (!node || Number(node.dataset.index) !== index) {
        anchorCorrectionFrameRef.current = null;
        return;
      }
      const offset = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (Math.abs(offset - currentAnchor.top) > 0.5) element.scrollTop += offset - currentAnchor.top;
      if (framesRemaining > 0) {
        anchorCorrectionFrameRef.current = requestAnimationFrame(() => correctAnchor(framesRemaining - 1));
      } else {
        anchorCorrectionFrameRef.current = null;
        pendingAnchorRef.current = null;
        suppressTopScrollRef.current = true;
        captureAnchor();
      }
    };
    correctAnchor(3);
  }, [rows, virtualItems]);

  function requestOlder(): void {
    if (!hasMore || loading || olderPending || error || messages.length === 0) return;
    const key = `${buffer.id}:${messages[0].id}`;
    if (requestedOldestRef.current === key) return;
    requestedOldestRef.current = key;
    captureAnchor();
    void onLoadOlder();
  }
  function scheduleOlderRequest(): void {
    if (olderRequestFrameRef.current !== null) return;
    const requestBufferId = buffer.id;
    olderRequestFrameRef.current = requestAnimationFrame(() => {
      olderRequestFrameRef.current = null;
      const element = scrollRef.current;
      if (currentBufferIdRef.current !== requestBufferId || !element || element.scrollTop > 180) return;
      captureAnchor();
      requestOlder();
    });
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (scrollReadyRef.current && element && element.scrollHeight <= element.clientHeight + 1
      && element.scrollTop <= 180) requestOlder();
  }, [buffer.id, messages, hasMore, loading, olderPending, error, rows]);
  return (
    <div
      className={['message-scroll', preferences.showSeconds ? 'message-time-seconds' : '', preferences.twelveHour ? 'message-time-twelve-hour' : ''].filter(Boolean).join(' ')}
      ref={scrollRef}
      role="log"
      aria-label={`${buffer.name} messages`}
      aria-live="polite"
      onScroll={() => {
        captureAnchor();
        if (suppressTopScrollRef.current) {
          suppressTopScrollRef.current = false;
          return;
        }
        if (!pendingAnchorRef.current && scrollReadyRef.current && scrollRef.current && scrollRef.current.scrollTop <= 180) scheduleOlderRequest();
      }}
    >
      <div className="history-controls">
        {hasMore ? (
          <button className="button button-quiet" type="button" disabled={olderPending || loading} onClick={() => {
            captureAnchor();
            requestedOldestRef.current = `${buffer.id}:${messages[0]?.id}`;
            void onLoadOlder();
          }}>
            {olderPending ? 'Loading older messages…' : 'Load older messages'}
          </button>
        ) : null}
        {error ? (
          <div className="error-text">
            <span>{error}</span>
            <button className="text-button" type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : null}
      </div>
      {loading && messages.length === 0 ? <div className="muted" role="status" style={{ padding: '12px 24px' }}>Loading messages…</div> : null}
      {!loading && !error && messages.length === 0 ? <div className="muted" style={{ padding: '12px 24px' }}>No messages yet.</div> : null}
      <ul className="message-list" style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const rowStyle = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start}px)`,
          };
          if (row.type === 'date') return (
            <li className="message-date-separator" key={virtualRow.key} data-index={virtualRow.index}
              ref={virtualizer.measureElement} style={rowStyle}>
              <time dateTime={`${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}-${String(row.date.getDate()).padStart(2, '0')}`}>
                {dateFormatter.format(row.date)}
              </time>
            </li>
          );
          const message = row.message;
          const identity = displayIdentity(message, relayNicks, displayNames);
          const text = identity.text;
          const isOwnMessage = Boolean(identity.mentionTarget && normalizedOwnNames.some((name) => name.toLowerCase() === identity.mentionTarget!.toLowerCase()));
          const ranges = message.kind !== 'system' && !isOwnMessage ? mentionRanges(text, normalizedOwnNames) : [];
          const hasOwnMention = ranges.length > 0 || message.kind !== 'system' && !isOwnMessage
            && highlights.some((phrase) => text.toLowerCase().includes(phrase));
          const rowClass = [
            'message-row',
            message.kind === 'system' ? 'message-system' : '',
            message.kind === 'notice' ? 'message-notice' : '',
            message.kind === 'action' ? 'message-action' : '',
            message.kind === 'system' && !message.connectionEvent && preferences.statusMessages === 'compact' ? 'message-compact' : '',
            hasOwnMention ? 'message-mention' : '',
            jumpId === message.id ? 'message-highlight' : '',
          ].filter(Boolean).join(' ');
          const nick = identity.nick;
          const nickColor = preferences.coloredNicknames && nick && message.kind !== 'system'
            ? nicknameColor(identity.mentionTarget ?? nick, theme) : undefined;
          let cursor = 0;
          const body: ReactNode[] = [];
          for (const range of ranges) {
            if (range.start > cursor) body.push(text.slice(cursor, range.start));
            body.push(<mark className="mention-token" key={`${range.start}-${range.end}`}>{text.slice(range.start, range.end)}</mark>);
            cursor = range.end;
          }
          if (cursor < text.length || body.length === 0) body.push(text.slice(cursor));
          if (message.connectionEvent) return (
            <li className={`message-connection-marker message-connection-${message.connectionEvent}`} key={virtualRow.key}
              data-index={virtualRow.index} data-message-id={message.id} ref={virtualizer.measureElement} style={rowStyle}>
              <time dateTime={dateTimeLabel(message.time)}>{timeFormatter.format(new Date(message.time))}</time>
              <span>{text}</span>
            </li>
          );
          return (
            <li className={rowClass} key={virtualRow.key} data-index={virtualRow.index} data-message-id={message.id}
              ref={virtualizer.measureElement} style={rowStyle}>
              <time className="message-time" dateTime={dateTimeLabel(message.time)}>{timeFormatter.format(new Date(message.time))}</time>
              {nick && message.kind !== 'system' ? (
                <button className="message-nick" type="button" title={`Rename ${identity.mentionTarget ?? nick} (right-click for actions)`}
                  style={{ color: nickColor, border: 0, padding: 0, background: 'transparent', font: 'inherit', cursor: 'pointer' }}
                  onClick={() => onRename(identity.mentionTarget ?? nick, nick)}
                  onContextMenu={message.fromNetwork ? undefined : (event) => {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const pointer = event.clientX !== 0 || event.clientY !== 0;
                    onNickMenu(identity.mentionTarget ?? nick, pointer ? event.clientX : rect.left, pointer ? event.clientY : rect.bottom);
                  }}>{nick}</button>
              ) : <span className="message-nick">{message.kind === 'system' ? '*' : ''}</span>}
              <span className="message-text">
                {message.fromNetwork ? <span className="message-network-info" role="img" aria-label="From IRC network" title="From IRC network">ⓘ</span> : null}
                {body}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
