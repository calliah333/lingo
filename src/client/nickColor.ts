import type { Theme } from './ThemePicker';

/** Stable per-nick color shared by the transcript and the user list. */
export function nicknameColor(nick: string, theme: Theme): string {
  let hash = 2166136261;
  for (let i = 0; i < nick.length; i += 1) {
    hash ^= nick.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 67% ${theme === 'light' ? '27%' : '69%'})`;
}
