/**
 * What you did in this page session, per network, most recent first: whom you mentioned and which channels you
 * joined or talked in. Suggestions rank these first; nothing is persisted, so a reload starts fresh.
 */
const LIMIT = 50;
const mentions = new Map<number, string[]>();
const channels = new Map<number, string[]>();

export const sessionStartedAt = Date.now();

function remember(store: Map<number, string[]>, networkId: number, name: string): void {
  const key = name.trim().toLowerCase();
  if (!key) return;
  store.set(networkId, [key, ...(store.get(networkId) ?? []).filter((item) => item !== key)].slice(0, LIMIT));
}

export function rememberMention(networkId: number, mention: string): void {
  remember(mentions, networkId, mention);
}

export function rememberChannel(networkId: number, channel: string): void {
  remember(channels, networkId, channel);
}

/** Lowercased mention names, most recently used first. */
export function recentMentions(networkId: number): readonly string[] {
  return mentions.get(networkId) ?? [];
}

/** Lowercased channel names, most recently used first. */
export function recentChannels(networkId: number): readonly string[] {
  return channels.get(networkId) ?? [];
}
