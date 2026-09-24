import type { ChatBuffer, ChatMessage, Network, NetworkStatus } from '../shared/contracts';
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
