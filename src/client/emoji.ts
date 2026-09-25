/** `:shortcode` emoji suggestions for the composer, from GitHub's gemoji set (loaded on first use). */
export type Emoji = { emoji: string; names: string[]; tags: string[] };

/** Shortcodes are lowercase letters, digits, `_`, `+`, and `-` (`:+1:`, `:t-rex:`). */
const SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]{2,})$/i;

let loading: Promise<Emoji[]> | null = null;
let loaded: Emoji[] | null = null;

/** The emoji list once loaded, else null. */
export function loadedEmoji(): Emoji[] | null {
  return loaded;
}

/** Loads the list once; its own chunk keeps it out of the main bundle. */
export function loadEmoji(): Promise<Emoji[]> {
  loading ??= import('gemoji').then(({ gemoji }) => {
    loaded = gemoji.map(({ emoji, names, tags }) => ({ emoji, names, tags }));
    return loaded;
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The `:query` right before the caret (at least two characters, after a space, bracket, or line start). */
export function emojiContext(value: string, caret: number): { start: number; end: number; query: string } | null {
  const match = SHORTCODE.exec(value.slice(0, caret));
  if (!match) return null;
  const query = match[1];
  return { start: caret - query.length - 1, end: caret, query };
}

/**
 * Ranking: an exact shortcode, emoji you picked this session, shortcodes starting with the query, shortcodes
 * with a `_`-separated word starting with it, other shortcodes containing it, then tags starting with it;
 * ties keep gemoji's order.
 */
export function matchEmoji(list: readonly Emoji[], query: string, recent: readonly string[], limit: number): Emoji[] {
  const needle = query.toLowerCase();
  const scored: { emoji: Emoji; keys: number[] }[] = [];
  list.forEach((emoji, index) => {
    let match = Infinity;
    for (const name of emoji.names) {
      if (name === needle) match = Math.min(match, 0);
      else if (name.startsWith(needle)) match = Math.min(match, 1);
      else if (name.split(/[_-]/).some((word) => word.startsWith(needle))) match = Math.min(match, 2);
      else if (name.includes(needle)) match = Math.min(match, 3);
    }
    if (match === Infinity && emoji.tags.some((tag) => tag.startsWith(needle))) match = 4;
    if (match === Infinity) return;
    const used = recent.indexOf(emoji.emoji);
    scored.push({ emoji, keys: [match === 0 ? 0 : 1, used < 0 ? Infinity : used, match, index] });
  });
  return scored.sort((left, right) => {
    for (let key = 0; key < left.keys.length; key += 1) {
      if (left.keys[key] !== right.keys[key]) return left.keys[key] < right.keys[key] ? -1 : 1;
    }
    return 0;
  }).slice(0, limit).map((item) => item.emoji);
}
