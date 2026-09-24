import type { BufferUnread, ChatBuffer, ChatMessage, Network, NetworkStatus, SyncedSettings } from '../shared/contracts';
import { api } from './api';

export type MessagePage = { messages: ChatMessage[]; hasMore: boolean };

/** Merges two id-ordered message lists; incoming copies replace current ones with the same id. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return current;
  if (!current.length) return incoming;
  if (incoming[0].id > current.at(-1)!.id) return [...current, ...incoming];
  if (incoming.at(-1)!.id < current[0].id) return [...incoming, ...current];
  const merged: ChatMessage[] = [];
  let left = 0;
  let right = 0;
  while (left < current.length && right < incoming.length) {
    const currentId = current[left].id;
    const incomingId = incoming[right].id;
    if (currentId < incomingId) merged.push(current[left++]);
    else if (currentId > incomingId) merged.push(incoming[right++]);
    else {
      merged.push(incoming[right++]);
      left++;
    }
  }
  while (left < current.length) merged.push(current[left++]);
  while (right < incoming.length) merged.push(incoming[right++]);
  return merged;
}

export function messagePage(bufferId: number, before?: number, signal?: AbortSignal): Promise<MessagePage> {
  const params = new URLSearchParams({ bufferId: String(bufferId), limit: '100' });
  if (before !== undefined) params.set('before', String(before));
  return api<MessagePage>(`/api/messages?${params}`, { signal });
}

function sameChannel(left: string, right: string): boolean {
  const normalizedLeft = left.trim().replace(/^#+/, '').toLowerCase();
  const normalizedRight = right.trim().replace(/^#+/, '').toLowerCase();
  return normalizedLeft === normalizedRight;
}

export function isJoined(network: Network | undefined, channel: string): boolean {
  return !!network?.autojoin.some((name) => sameChannel(name, channel));
}

/** Names that count as "me" on a network: the live nick, the configured nick, and mention aliases. */
export function ownNames(network: Network | undefined, status: NetworkStatus | undefined): string[] {
  if (!network) return [];
  return [...new Set([status?.nick, network.nick, ...network.mentionAliases].filter(Boolean))] as string[];
}

/** Sidebar order: channels, then private conversations, each alphabetical without the channel prefix. */
export function sidebarOrder(left: ChatBuffer, right: ChatBuffer): number {
  if (left.kind !== right.kind) return left.kind === 'channel' ? -1 : right.kind === 'channel' ? 1 : 0;
  return left.name.replace(/^[#&+!]+/, '').localeCompare(right.name.replace(/^[#&+!]+/, ''), undefined, { sensitivity: 'base' });
}

/**
 * Every buffer the sidebar can show, in its order: each network's server buffer, then its other buffers.
 * Hidden buffers are left out; buffers of collapsed networks are kept (see `visibleBuffers`).
 */
export function orderedBuffers(networks: Network[], buffers: ChatBuffer[], settings: SyncedSettings): ChatBuffer[] {
  return networks.flatMap((network) => {
    const own = buffers.filter((buffer) => buffer.networkId === network.id);
    const server = own.filter((buffer) => buffer.kind === 'server');
    const rest = own.filter((buffer) => buffer.kind !== 'server' && !settings.hiddenBuffers.includes(buffer.id)).sort(sidebarOrder);
    return [...server, ...rest];
  });
}

/** The buffer rows on screen in the sidebar: a collapsed network shows only its heading (the server buffer). */
export function visibleBuffers(ordered: ChatBuffer[], settings: SyncedSettings): ChatBuffer[] {
  return ordered.filter((buffer) => buffer.kind === 'server' || !settings.collapsedNetworks.includes(buffer.networkId));
}

function isMuted(buffer: ChatBuffer, settings: SyncedSettings): boolean {
  return settings.mutedBuffers.includes(buffer.id) || settings.mutedNetworks.includes(buffer.networkId);
}

/** The next (`1`) or previous (`-1`) buffer after `currentId` that passes `accept`, wrapping around; null when none does. */
export function stepBuffer(ordered: ChatBuffer[], currentId: number | null, direction: 1 | -1,
  accept: (buffer: ChatBuffer) => boolean = () => true): ChatBuffer | null {
  const count = ordered.length;
  const found = ordered.findIndex((buffer) => buffer.id === currentId);
  const start = found === -1 ? (direction === 1 ? -1 : count) : found;
  for (let step = 1; step <= count; step++) {
    const buffer = ordered[(((start + step * direction) % count) + count) % count]!;
    if (buffer.id !== currentId && accept(buffer)) return buffer;
  }
  return null;
}

/** The next or previous unread, unmuted buffer; while any buffer has a mention, only buffers with mentions count. */
export function stepUnread(ordered: ChatBuffer[], currentId: number | null, direction: 1 | -1,
  unread: Record<number, BufferUnread>, settings: SyncedSettings): ChatBuffer | null {
  const candidates = ordered.filter((buffer) => buffer.id !== currentId && !!unread[buffer.id]?.messages && !isMuted(buffer, settings));
  const mentioned = new Set(candidates.filter((buffer) => unread[buffer.id]!.mentions > 0).map((buffer) => buffer.id));
  const eligible = mentioned.size ? mentioned : new Set(candidates.map((buffer) => buffer.id));
  return stepBuffer(ordered, currentId, direction, (buffer) => eligible.has(buffer.id));
}

/**
 * Scores a case-insensitive fuzzy match of `query` against `text`: its letters must appear in order.
 * Consecutive letters and letters at the start of a word score higher; an exact or prefix match (ignoring a
 * channel prefix) scores highest. Null when the text does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  const haystack = text.toLowerCase();
  if (!needle) return 0;
  const bare = (value: string) => value.replace(/^[#&+!]+/, '');
  if (bare(haystack) === bare(needle)) return 1000;
  let score = bare(haystack).startsWith(bare(needle)) ? 100 : 0;
  let from = 0;
  let previous = -2;
  for (const letter of needle) {
    const at = haystack.indexOf(letter, from);
    if (at === -1) return null;
    score += at === previous + 1 ? 3 : 1;
    if (at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]!)) score += 2;
    previous = at;
    from = at + 1;
  }
  return score - haystack.length / 100;
}

/** What the tab title and favicon announce: unmuted mentions first, otherwise whether anything unmuted is unread. */
export type Attention = { mentions: number; unread: boolean };

/** Sums the sidebar's unread state: buffers it hides and muted buffers or networks do not count. */
export function attention(buffers: ChatBuffer[], unread: Record<number, BufferUnread>, settings: SyncedSettings): Attention {
  let mentions = 0;
  let hasUnread = false;
  for (const buffer of buffers) {
    const counts = unread[buffer.id];
    if (!counts?.messages || settings.hiddenBuffers.includes(buffer.id) || isMuted(buffer, settings)) continue;
    hasUnread = true;
    mentions += counts.mentions;
  }
  return { mentions, unread: hasUnread };
}
