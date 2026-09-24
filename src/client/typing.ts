import { useCallback, useEffect, useState } from 'react';
import type { TypingState } from '../shared/contracts';

/** IRCv3 `+typing`: an `active` state holds for 6 s and a `paused` one for 30 s without an update. */
const HOLD_MS: Record<Exclude<TypingState, 'done'>, number> = { active: 6_000, paused: 30_000 };
/** Minimum gap between any two notifications we send to one target. */
export const TYPING_INTERVAL_MS = 3_000;

type Typer = { nick: string; expires: number };
export type Typers = Record<number, Typer[]>;

function without(current: Typers, bufferId: number, keep: (typer: Typer) => boolean): Typers {
  const list = current[bufferId];
  if (!list) return current;
  const kept = list.filter(keep);
  if (kept.length === list.length) return current;
  const next = { ...current };
  if (kept.length) next[bufferId] = kept;
  else delete next[bufferId];
  return next;
}

/**
 * Who is typing in each buffer. `update` applies a `typing` event (or `done` when the nick's message
 * arrives); `retain` drops typers who are no longer in a channel's roster.
 */
export function useTypers() {
  const [typers, setTypers] = useState<Typers>({});
  const update = useCallback((bufferId: number, nick: string, state: TypingState) => {
    const key = nick.toLowerCase();
    setTypers((current) => {
      if (state === 'done') return without(current, bufferId, (typer) => typer.nick.toLowerCase() !== key);
      const others = (current[bufferId] ?? []).filter((typer) => typer.nick.toLowerCase() !== key);
      return { ...current, [bufferId]: [...others, { nick, expires: Date.now() + HOLD_MS[state] }] };
    });
  }, []);
  const retain = useCallback((bufferId: number, nicks: readonly string[]) => {
    const present = new Set(nicks.map((nick) => nick.toLowerCase()));
    setTypers((current) => without(current, bufferId, (typer) => present.has(typer.nick.toLowerCase())));
  }, []);
  useEffect(() => {
    let next = Infinity;
    for (const list of Object.values(typers)) for (const typer of list) next = Math.min(next, typer.expires);
    if (next === Infinity) return;
    const timer = window.setTimeout(() => setTypers((current) => {
      const now = Date.now();
      let pruned = current;
      for (const id of Object.keys(current)) pruned = without(pruned, Number(id), (typer) => typer.expires > now);
      return pruned;
    }), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [typers]);
  return { typers, update, retain };
}

/** "alice is typing…", "alice and bob are typing…", up to three names. */
export function typingText(names: readonly string[]): string {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing…`;
  return 'Several people are typing…';
}
