import type { Theme } from './ThemePicker';

export type AppPreferences = {
  showMotd: boolean;
  showSeconds: boolean;
  twelveHour: boolean;
  statusMessages: 'inline' | 'compact' | 'hidden';
  coloredNicknames: boolean;
  autocomplete: boolean;
  theme: Theme;
  fontFamily: FontFamily;
  fontSize: number;
  browserNotifications: boolean;
  notificationSound: boolean;
  highlights: string[];
};

export const fontFamilies = {
  default: { label: 'Default monospace', stack: null },
  menlo: { label: 'Menlo', stack: "Menlo, Monaco, 'SFMono-Regular', monospace" },
  consolas: { label: 'Consolas', stack: "Consolas, 'Liberation Mono', monospace" },
  courier: { label: 'Courier', stack: "'Courier New', Courier, monospace" },
  jetbrains: { label: 'JetBrains Mono', stack: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" },
  fira: { label: 'Fira Code', stack: "'Fira Code', 'SFMono-Regular', Consolas, monospace" },
  sans: { label: 'System sans-serif', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  serif: { label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
} satisfies Record<string, { label: string; stack: string | null }>;
export type FontFamily = keyof typeof fontFamilies;

export const minFontSize = 10;
export const maxFontSize = 20;

const storageKey = 'lingo-preferences';

const defaults: AppPreferences = {
  showMotd: true,
  showSeconds: false,
  twelveHour: false,
  statusMessages: 'inline',
  coloredNicknames: true,
  autocomplete: true,
  theme: 'dark',
  fontFamily: 'default',
  fontSize: 13,
  browserNotifications: false,
  notificationSound: false,
  highlights: [],
};

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light' || value === 'gruber';
}

function isFontFamily(value: unknown): value is FontFamily {
  return typeof value === 'string' && Object.hasOwn(fontFamilies, value);
}

export function loadPreferences(): AppPreferences {
  let stored: unknown;
  let legacyTheme: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    legacyTheme = localStorage.getItem('lingo-theme');
  } catch {
    return { ...defaults, highlights: [] };
  }
  const value = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown> : {};
  const highlights = Array.isArray(value.highlights) ? value.highlights : [];
  return {
    showMotd: typeof value.showMotd === 'boolean' ? value.showMotd : defaults.showMotd,
    showSeconds: typeof value.showSeconds === 'boolean' ? value.showSeconds : defaults.showSeconds,
    twelveHour: typeof value.twelveHour === 'boolean' ? value.twelveHour : defaults.twelveHour,
    statusMessages: value.statusMessages === 'inline' || value.statusMessages === 'compact' || value.statusMessages === 'hidden'
      ? value.statusMessages : defaults.statusMessages,
    coloredNicknames: typeof value.coloredNicknames === 'boolean' ? value.coloredNicknames : defaults.coloredNicknames,
    autocomplete: typeof value.autocomplete === 'boolean' ? value.autocomplete : defaults.autocomplete,
    theme: isTheme(value.theme) ? value.theme : isTheme(legacyTheme) ? legacyTheme : defaults.theme,
    fontFamily: isFontFamily(value.fontFamily) ? value.fontFamily : defaults.fontFamily,
    fontSize: typeof value.fontSize === 'number' && Number.isInteger(value.fontSize)
      && value.fontSize >= minFontSize && value.fontSize <= maxFontSize ? value.fontSize : defaults.fontSize,
    browserNotifications: typeof value.browserNotifications === 'boolean' ? value.browserNotifications : defaults.browserNotifications,
    notificationSound: typeof value.notificationSound === 'boolean' ? value.notificationSound : defaults.notificationSound,
    highlights: [...new Set(highlights.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim()).filter(Boolean))],
  };
}

export function savePreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    localStorage.setItem('lingo-theme', preferences.theme);
  } catch { /* Browser storage may be unavailable. */ }
}

/** Theme and fonts live on <html> so styles apply before and outside React. */
export function applyAppearance(preferences: AppPreferences): void {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  const stack = fontFamilies[preferences.fontFamily].stack;
  if (stack) root.style.setProperty('--mono', stack);
  else root.style.removeProperty('--mono');
  root.style.setProperty('--font-size', `${preferences.fontSize}px`);
}
