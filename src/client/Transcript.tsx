import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatBuffer, ChatMessage, Network } from '../shared/contracts';
import { displayIdentity, mentionRanges } from '../shared/identity';
import Icon from './Icon';
import { parseFormatting, renderFormatted, withoutColors } from './ircFormat';
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
  /** Draw "New messages" before the first message after this id; null for no divider. */
  dividerAfter: number | null;
  onBottomChange: (bufferId: number, atBottom: boolean) => void;
  onLoadOlder: () => Promise<void>;
  onRetry: () => void;
  /** Opens user actions for the IRC nick behind a message (the relayed nick for bridged users). */
  onNickMenu: (nick: string, x: number, y: number) => void;
  /** Leaves a search jump and returns to the newest messages. */
  onBackToLatest: () => void;
  preferences: AppPreferences;
  highlights: string[];
  theme: Theme;
};

type TranscriptRow =
  | { type: 'date'; key: string; date: Date }
  | { type: 'unread'; key: string }
  | { type: 'message'; key: string; message: ChatMessage }
  /** Consecutive MOTD lines drawn as one block; anchored by its first line's id. */
  | { type: 'motd'; key: string; messages: ChatMessage[] };

type Anchor = { id: number; top: number };

function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Local midnight of the current day; re-renders when the clock passes the next midnight. */
function useToday(): number {
  const [today, setToday] = useState(() => new Date().setHours(0, 0, 0, 0));
  useEffect(() => {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    const timer = setTimeout(() => setToday(new Date().setHours(0, 0, 0, 0)), Math.max(0, next.getTime() - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

/** "Today"/"Yesterday" for those local days, otherwise null. */
function relativeDay(date: Date, today: number): string | null {
  const day = localDay(date.getTime());
  if (day === localDay(today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === localDay(yesterday.getTime()) ? 'Yesterday' : null;
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
  dividerAfter,
  onBottomChange,
  onLoadOlder,
  onRetry,
  onNickMenu,
  onBackToLatest,
  preferences,
  highlights: highlightPhrases,
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
  const [showLatest, setShowLatest] = useState(false);
  const relayNicks = network.relayNicks ?? [];
  const displayNames = network.displayNames ?? {};
  const ownNamesKey = ownNames.join('\u0000');
  const normalizedOwnNames = useMemo(() => ownNames.filter(Boolean), [ownNamesKey]);
  const highlightsKey = highlightPhrases.join('\u0000');
  const highlights = useMemo(() => highlightPhrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean), [highlightsKey]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', ...(preferences.showSeconds ? { second: '2-digit' } : {}),
    hour12: preferences.twelveHour,
  }), [preferences.showSeconds, preferences.twelveHour]);
  /** Characters in the widest time this format produces (hour 10–12 or 22–23 with an AM/PM marker), for the time column. */
  const timeWidth = useMemo(() => Math.max(...[10, 12, 22, 23].map((hour) =>
    timeFormatter.format(new Date(2000, 0, 1, hour, 59, 59)).length)), [timeFormatter]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }), []);
  /** Hover text for a timestamp: the full date and the time with seconds. */
  const fullDateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full', timeStyle: 'medium', hour12: preferences.twelveHour,
  }), [preferences.twelveHour]);
  function timeCell(time: number) {
    const date = new Date(time);
    return <time className="line__time" dateTime={dateTimeLabel(time)}
      title={Number.isNaN(date.getTime()) ? undefined : fullDateTimeFormatter.format(date)}>{timeFormatter.format(date)}</time>;
  }
  const today = useToday();
  const rows = useMemo(() => {
    const result: TranscriptRow[] = [];
    let divided = false;
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
      if (!divided && dividerAfter !== null && message.id > dividerAfter && !message.membership) {
        result.push({ type: 'unread', key: `unread:${message.id}` });
        divided = true;
      }
      // A date or unread separator in between starts a new block.
      const last = result.at(-1);
      if (message.isMotd && last?.type === 'motd') last.messages.push(message);
      else if (message.isMotd) result.push({ type: 'motd', key: `motd:${message.id}`, messages: [message] });
      else result.push({ type: 'message', key: `message:${message.id}`, message });
    }
    return result;
  }, [messages, preferences.showMotd, preferences.statusMessages, dividerAfter]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row?.type === 'date' ? 32 : row?.type === 'unread' ? 30
        : row?.type === 'motd' ? row.messages.length * 20 + 10
        : row?.type === 'message' && row.message.connectionEvent ? 30 : 25;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
  });
  const totalSize = virtualizer.getTotalSize();
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

  /** The row holding a message, including a line inside a MOTD block. */
  function rowIndexOf(id: number): number {
    return rows.findIndex((row) => row.type === 'message' ? row.message.id === id
      : row.type === 'motd' && row.messages.some((message) => message.id === id));
  }

  /** The rendered element for a message (a row, or a MOTD line) and the virtual index of the row containing it. */
  function renderedMessage(element: HTMLElement, id: number): { node: HTMLElement; index: number } | null {
    const node = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    const row = node?.closest<HTMLElement>('[data-index]');
    return node && row ? { node, index: Number(row.dataset.index) } : null;
  }

  function restoreAnchor(anchor: Anchor, forcePosition = false): void {
    const element = scrollRef.current;
    if (!element) return;
    const index = rowIndexOf(anchor.id);
    if (index < 0) return;
    const rendered = renderedMessage(element, anchor.id);
    if (!forcePosition && rendered && rendered.index === index) {
      element.scrollTop += rendered.node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.top;
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
      const index = rowIndexOf(jumpId);
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
        const index = rowIndexOf(oldFirstId);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
      }
      suppressTopScrollRef.current = true;
      atBottomRef.current = false;
      return;
    }
    if (!scrollReadyRef.current && jumpId === null && dividerAfter !== null && messages.length > 0) {
      const firstUnread = rows.findIndex((row) => row.type === 'unread');
      if (firstUnread !== -1) {
        atBottomRef.current = false;
        scrollReadyRef.current = true;
        virtualizer.scrollToIndex(firstUnread, { align: 'start' });
        return;
      }
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
  }, [buffer.id, messages, rows, hasMore, jumpId, dividerAfter, virtualizer]);

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
      const index = rowIndexOf(currentAnchor.id);
      const rendered = renderedMessage(element, currentAnchor.id);
      if (!rendered || rendered.index !== index) {
        anchorCorrectionFrameRef.current = null;
        return;
      }
      const offset = rendered.node.getBoundingClientRect().top - element.getBoundingClientRect().top;
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
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      atBottomRef.current = atBottom;
      onBottomChange(buffer.id, !loading && jumpId === null && messages.length > 0 && atBottom);
      updateLatestButton();
    });
    return () => cancelAnimationFrame(frame);
  }, [buffer.id, messages, loading, jumpId, totalSize, onBottomChange]);

  function updateLatestButton(): void {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowLatest(messages.length > 0 && (jumpId !== null || distance > 320));
  }

  function scrollToLatest(): void {
    if (jumpId !== null) {
      onBackToLatest();
      return;
    }
    const element = scrollRef.current;
    if (!element || !rows.length) return;
    atBottomRef.current = true;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    element.scrollTop = element.scrollHeight;
  }

  return <div className="transcript">
    <div
      className="message-scroll"
      ref={scrollRef}
      role="log"
      aria-label={`${buffer.name} messages`}
      aria-live="polite"
      onScroll={() => {
        captureAnchor();
        updateLatestButton();
        const element = scrollRef.current;
        if (element) onBottomChange(buffer.id, !loading && jumpId === null && messages.length > 0
          && element.scrollHeight - element.scrollTop - element.clientHeight < 48);
        if (suppressTopScrollRef.current) {
          suppressTopScrollRef.current = false;
          return;
        }
        if (!pendingAnchorRef.current && scrollReadyRef.current && scrollRef.current && scrollRef.current.scrollTop <= 180) scheduleOlderRequest();
      }}
    >
      <div className="history-controls">
        {hasMore ? (
          <button className="button button-quiet button-small" type="button" disabled={olderPending || loading} onClick={() => {
            captureAnchor();
            requestedOldestRef.current = `${buffer.id}:${messages[0]?.id}`;
            void onLoadOlder();
          }}>
            {olderPending ? 'Loading older messages…' : 'Load older messages'}
          </button>
        ) : !loading && messages.length > 0 ? <span className="history-start">Beginning of {buffer.name}</span> : null}
        {error ? (
          <div className="error-text">
            <span>{error}</span>
            <button className="text-button" type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : null}
      </div>
      {loading && messages.length === 0 ? <div className="transcript-state" role="status">Loading messages…</div> : null}
      {!loading && !error && messages.length === 0 ? <div className="transcript-state">
        <strong>No messages yet</strong>
        <span>{buffer.kind === 'server' ? 'Server notices and command output appear here.' : 'New messages will appear here as they arrive.'}</span>
      </div> : null}
      <ul className="line-list" style={{ height: `${totalSize}px`, '--time-width': `${timeWidth}ch` } as CSSProperties}>
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const key = virtualRow.key;
          const attributes = {
            'data-index': virtualRow.index,
            ref: virtualizer.measureElement,
            style: { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` } satisfies CSSProperties,
          };
          if (row.type === 'date') {
            const fullDate = dateFormatter.format(row.date);
            const relative = relativeDay(row.date, today);
            return <li key={key} {...attributes} className="line-separator">
              <time dateTime={`${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}-${String(row.date.getDate()).padStart(2, '0')}`}
                title={relative ? fullDate : undefined}>{relative ?? fullDate}</time>
            </li>;
          }
          if (row.type === 'unread') return <li key={key} {...attributes} className="line-separator line-separator--unread">
            <span>New messages</span>
          </li>;
          if (row.type === 'motd') {
            const first = row.messages[0];
            return <li key={key} {...attributes} className="line line--motd" data-message-id={first.id}>
              {timeCell(first.time)}
              <span className="line__from line__marker" title="Message of the day">motd</span>
              <pre className="line__body line__motd" aria-label="Message of the day">{row.messages.map((line) => (
                <span key={line.id} data-message-id={line.id} className={jumpId === line.id ? 'line__motd-line is-jump' : 'line__motd-line'}>
                  {renderFormatted(withoutColors(parseFormatting(line.text)), { links: true })}
                </span>
              ))}</pre>
            </li>;
          }
          const message = row.message;
          const time = timeCell(message.time);
          if (message.connectionEvent) return <li key={key} {...attributes} className="line line--connection" data-message-id={message.id}>
            {time}
            <span className="line__from" aria-hidden="true" />
            <span className="line__body">{parseFormatting(message.text).plain}</span>
          </li>;
          const identity = displayIdentity(message, relayNicks, displayNames);
          const formatted = parseFormatting(identity.text);
          const text = formatted.plain;
          const system = message.kind === 'system';
          const mentionTarget = identity.mentionTarget;
          const own = !!mentionTarget && normalizedOwnNames.some((name) => name.toLowerCase() === mentionTarget.toLowerCase());
          const ranges = !system && !own ? mentionRanges(text, normalizedOwnNames) : [];
          const mentioned = ranges.length > 0 || !system && !own && highlights.some((phrase) => text.toLowerCase().includes(phrase));
          const className = [
            'line',
            `line--${message.kind}`,
            system && preferences.statusMessages === 'compact' && 'line--compact',
            mentioned && 'is-mention',
            jumpId === message.id && 'is-jump',
          ].filter(Boolean).join(' ');
          const nick = identity.nick;
          const target = identity.mentionTarget ?? nick;
          return <li key={key} {...attributes} className={className} data-message-id={message.id}>
            {time}
            {nick && target && !system
              ? <button className="line__from" type="button" title={`${target} — click for actions`} aria-haspopup="menu"
                style={preferences.coloredNicknames ? { color: nicknameColor(target, theme) } : undefined}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onNickMenu(target, rect.left, rect.bottom + 4);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const pointer = event.clientX !== 0 || event.clientY !== 0;
                  onNickMenu(target, pointer ? event.clientX : rect.left, pointer ? event.clientY : rect.bottom);
                }}>{nick}</button>
              : message.fromNetwork
                ? <span className="line__from line__marker" role="img" aria-label="From IRC network" title="From IRC network"><Icon name="info" /></span>
                : <span className="line__from line__marker" aria-hidden="true">{system ? '•' : ''}</span>}
            <span className="line__body">{renderFormatted(formatted, { mentions: ranges, links: true })}</span>
          </li>;
        })}
      </ul>
    </div>
    {showLatest && <button type="button" className="transcript-latest" onClick={scrollToLatest}>
      <Icon name="arrowDown" />{jumpId !== null ? 'Back to latest' : 'Jump to latest'}
    </button>}
  </div>;
}
