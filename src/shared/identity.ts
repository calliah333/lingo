import type { ChatMessage } from './contracts.ts';

export interface DisplayIdentity {
  nick: string | null;
  text: string;
  relayed: boolean;
  mentionTarget: string | null;
}

const nickCharacter = /[\p{L}\p{N}\p{M}_\[\]\\`^{}|\-]/u;

function isNickCharacterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const first = text.charCodeAt(index);
  const codePoint = first >= 0xdc00 && first <= 0xdfff && index > 0
    ? text.codePointAt(index - 1)!
    : text.codePointAt(index)!;
  return nickCharacter.test(String.fromCodePoint(codePoint));
}

/** Resolve a configured bridge prefix without changing the stored IRC message. */
export function displayIdentity(
  message: Pick<ChatMessage, 'nick' | 'text'>,
  relayNicks: readonly string[],
  displayNames?: Readonly<Record<string, string>>,
): DisplayIdentity {
  let { nick, text } = message;
  let relayed = false;
  if (nick && (text[0] === '[' || text[0] === '<')) {
    const source = nick.toLowerCase();
    for (const relay of relayNicks) {
      if (relay.toLowerCase() !== source) continue;
      const end = text.indexOf(text[0] === '[' ? ']' : '>', 1);
      if (end !== -1 && text[end + 1] === ' ' && end + 2 < text.length) {
        const sender = text.slice(1, end).trim();
        const body = text.slice(end + 2);
        if (sender.length >= 1 && sender.length <= 48 && !/[\r\n\0]/u.test(sender)
          && !sender.includes(text[0]!) && body.trim()) {
          nick = sender;
          text = body;
          relayed = true;
        }
      }
      break;
    }
  }
  const mentionTarget = nick;
  if (nick && displayNames) {
    const key = nick.toLowerCase();
    for (const source in displayNames) {
      if (!Object.hasOwn(displayNames, source) || source.toLowerCase() !== key) continue;
      const label = displayNames[source];
      if (label?.trim()) {
        nick = label;
        break;
      }
    }
  }
  return { nick, text, relayed, mentionTarget };
}

/** Ranges are UTF-16 offsets into the original message, including @ when present. */
export function mentionRanges(text: string, names: readonly string[]): Array<{ start: number; end: number }> {
  if (!text || names.length === 0) return [];
  const folded = text.toLowerCase();
  // Lowercasing a few Unicode characters expands their UTF-16 length. Keep
  // ranges tied to the original string rather than to the folded search text.
  let offsets: number[] | undefined;
  if (folded.length !== text.length) {
    offsets = [0];
    let original = 0;
    for (const character of text) {
      const width = character.toLowerCase().length;
      for (let i = 1; i < width; i++) offsets.push(-1);
      original += character.length;
      offsets.push(original);
    }
  }

  const found: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    const needle = name.trim().toLowerCase();
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    let from = 0;
    while (from < folded.length) {
      const match = folded.indexOf(needle, from);
      if (match < 0) break;
      from = match + 1;
      const start = offsets ? offsets[match] : match;
      const end = offsets ? offsets[match + needle.length] : match + needle.length;
      if (start === undefined || end === undefined || start < 0 || end < 0
        || text.slice(start, end).toLowerCase() !== needle || isNickCharacterAt(text, end)) continue;
      let rangeStart = start;
      if (text[start - 1] === '@') {
        if (isNickCharacterAt(text, start - 2)) continue;
        rangeStart--;
      } else if (isNickCharacterAt(text, start - 1)) {
        continue;
      }
      found.push({ start: rangeStart, end });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: typeof found = [];
  for (const range of found) {
    if (range.start >= (ranges.at(-1)?.end ?? 0)) ranges.push(range);
  }
  return ranges;
}

export function mentionsAny(text: string, names: readonly string[]): boolean {
  return mentionRanges(text, names).length > 0;
}
