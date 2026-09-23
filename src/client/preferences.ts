import type { Theme } from './ThemePicker';

export type AppPreferences = {
  showMotd: boolean;
  showSeconds: boolean;
  twelveHour: boolean;
  statusMessages: 'inline' | 'compact' | 'hidden';
  coloredNicknames: boolean;
  autocomplete: boolean;
  theme: Theme;
  browserNotifications: boolean;
  notificationSound: boolean;
  highlights: string[];
};

const storageKey = 'lingo-preferences';

const defaults: AppPreferences = {
  showMotd: true,
  showSeconds: false,
  twelveHour: false,
  statusMessages: 'inline',
  coloredNicknames: true,
  autocomplete: true,
  theme: 'dark',
  browserNotifications: false,
  notificationSound: false,
  highlights: [],
};

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light' || value === 'gruber';
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
