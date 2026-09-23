import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatBuffer, ChatMessage, Network } from '../shared/contracts';
import { displayIdentity, mentionRanges, mentionsAny } from '../shared/identity';
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
  theme: Theme;
};

function nicknameColor(nick: string, theme: Theme): string {
  let hash = 2166136261;
  for (let i = 0; i < nick.length; i += 1) {
    hash ^= nick.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 67% ${theme === 'light' ? '27%' : '69%'})`;
}

function timeLabel(time: number): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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
  theme,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ id: number; top: number } | null>(null);
  const atBottomRef = useRef(true);
  const previousRef = useRef<{ bufferId: number; messages: ChatMessage[] }>({ bufferId: buffer.id, messages: [] });
  const lastJumpRef = useRef<number | null>(null);
  const relayNicks = network.relayNicks ?? [];
  const displayNames = network.displayNames ?? {};
  const ownNamesKey = ownNames.join('\u0000');
  const normalizedOwnNames = useMemo(() => ownNames.filter(Boolean), [ownNamesKey]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();

  function captureAnchor(): void {
    const element = scrollRef.current;
    if (!element) return;
    const bottomGap = element.scrollHeight - element.scrollTop - element.clientHeight;
    atBottomRef.current = bottomGap < 48;
    const first = virtualItems.find((item) => item.end > element.scrollTop);
    const message = first ? messages[first.index] : undefined;
    if (message) {
      const row = element.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
      if (row) anchorRef.current = { id: message.id, top: row.getBoundingClientRect().top - element.getBoundingClientRect().top };
    }
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = previousRef.current;
    const changedBuffer = previous.bufferId !== buffer.id;
    const oldMessages = previous.messages;
    previousRef.current = { bufferId: buffer.id, messages };

    if (changedBuffer) {
      atBottomRef.current = true;
      anchorRef.current = null;
      lastJumpRef.current = null;
    }

    if (jumpId !== null && jumpId !== lastJumpRef.current) {
      const index = messages.findIndex((message) => message.id === jumpId);
      if (index !== -1) {
        virtualizer.scrollToIndex(index, { align: 'center' });
        lastJumpRef.current = jumpId;
        return;
      }
    }

    const oldFirstId = oldMessages[0]?.id;
    const newFirstIndex = oldFirstId === undefined ? -1 : messages.findIndex((message) => message.id === oldFirstId);
    const prepended = !changedBuffer && oldFirstId !== undefined && newFirstIndex > 0;
    if (prepended) {
      const anchor = anchorRef.current;
      if (anchor) {
        const row = element.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
        if (row) {
          const currentTop = row.getBoundingClientRect().top - element.getBoundingClientRect().top;
          element.scrollTop += currentTop - anchor.top;
        } else {
          const anchorIndex = messages.findIndex((message) => message.id === anchor.id);
          if (anchorIndex !== -1) {
            virtualizer.scrollToIndex(anchorIndex, { align: 'start' });
            element.scrollTop = Math.max(0, element.scrollTop - anchor.top);
          } else {
            virtualizer.scrollToIndex(newFirstIndex, { align: 'start' });
          }
        }
      } else {
        virtualizer.scrollToIndex(newFirstIndex, { align: 'start' });
      }
      atBottomRef.current = false;
      return;
    }

    const appended = !changedBuffer && oldMessages.length > 0
      && messages.length > oldMessages.length
      && oldMessages.every((message, index) => messages[index]?.id === message.id);
    if (changedBuffer || appended && atBottomRef.current || oldMessages.length === 0 && messages.length > 0 && atBottomRef.current) {
      if (messages.length) {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
        element.scrollTop = element.scrollHeight;
      } else element.scrollTop = element.scrollHeight;
    }
  }, [buffer.id, messages, jumpId, virtualizer]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const first = virtualItems[0];
    const element = scrollRef.current;
    const rowMessage = first ? messages[first.index] : undefined;
    const row = element && rowMessage
      ? element.querySelector<HTMLElement>(`[data-message-id="${rowMessage.id}"]`)
      : null;
    if (row && element) anchorRef.current = {
      id: rowMessage!.id,
      top: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  }, []);

  return (
    <div
      className="message-scroll"
      ref={scrollRef}
      role="log"
      aria-label={`${buffer.name} messages`}
      aria-live="polite"
      onScroll={captureAnchor}
    >
      <div className="history-controls">
        {hasMore ? (
          <button className="button button-quiet" type="button" disabled={olderPending || loading} onClick={() => void onLoadOlder()}>
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
          const message = messages[virtualRow.index];
          const identity = displayIdentity(message, relayNicks, displayNames);
          const text = identity.text;
          const isOwnMessage = Boolean(identity.mentionTarget && normalizedOwnNames.some((name) => name.toLowerCase() === identity.mentionTarget!.toLowerCase()));
          const hasOwnMention = message.kind !== 'system' && !isOwnMessage && mentionsAny(text, normalizedOwnNames);
          const ranges = hasOwnMention ? mentionRanges(text, normalizedOwnNames) : [];
          const rowClass = [
            'message-row',
            message.kind === 'system' ? 'message-system' : '',
            message.kind === 'notice' ? 'message-notice' : '',
            message.kind === 'action' ? 'message-action' : '',
            hasOwnMention ? 'message-mention' : '',
            jumpId === message.id ? 'message-highlight' : '',
          ].filter(Boolean).join(' ');
          const nick = identity.nick;
          const nickColor = nick && message.kind !== 'system' ? nicknameColor(identity.mentionTarget ?? nick, theme) : undefined;
          let cursor = 0;
          const body: ReactNode[] = [];
          for (const range of ranges) {
            if (range.start > cursor) body.push(text.slice(cursor, range.start));
            body.push(<mark className="mention-token" key={`${range.start}-${range.end}`}>{text.slice(range.start, range.end)}</mark>);
            cursor = range.end;
          }
          if (cursor < text.length || body.length === 0) body.push(text.slice(cursor));
          const rowStyle = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start}px)`,
          };

          return (
            <li
              className={rowClass}
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-message-id={message.id}
              ref={virtualizer.measureElement}
              style={rowStyle}
            >
              <time className="message-time" dateTime={dateTimeLabel(message.time)}>{timeLabel(message.time)}</time>
              {nick && message.kind !== 'system' ? (
                <button
                  className="message-nick"
                  type="button"
                  title={`Rename ${identity.mentionTarget ?? nick}`}
                  style={{ color: nickColor, border: 0, padding: 0, background: 'transparent', font: 'inherit', cursor: 'pointer' }}
                  onClick={() => onRename(identity.mentionTarget ?? nick, nick)}
                >{nick}</button>
              ) : <span className="message-nick">{message.kind === 'system' ? '*' : ''}</span>}
              <span className="message-text">
                {message.kind === 'action' ? <><span className="action-marker">*</span>{' '}{body}</> : body}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
