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
  /** Transcript nickname column width, in characters. */
  nickWidth: number;
  /** Custom networks sidebar width in px; `null` uses the responsive default. */
  sidebarWidth: number | null;
  sidebarCollapsed: boolean;
  browserNotifications: boolean;
  notificationSound: boolean;
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
export const minNickWidth = 4;
export const maxNickWidth = 32;
export const minSidebarWidth = 160;
export const maxSidebarWidth = 520;

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
  nickWidth: 12,
  sidebarWidth: null,
  sidebarCollapsed: false,
  browserNotifications: false,
  notificationSound: false,
};

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light' || value === 'gruber';
}

function isFontFamily(value: unknown): value is FontFamily {
  return typeof value === 'string' && Object.hasOwn(fontFamilies, value);
}

/** Legacy account choices are read only during the first server-settings bootstrap. */
export function legacyHighlights(): string[] | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Object.hasOwn(stored, 'highlights')) return null;
    const value = (stored as Record<string, unknown>).highlights;
    if (!Array.isArray(value)) return null;
    return [...new Set(value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 100 && !/[\r\n]/.test(item)))].slice(0, 100);
  } catch {
    return null;
  }
}

export function clearLegacyHighlights(): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && Object.hasOwn(stored, 'highlights')) {
      const next = { ...stored as Record<string, unknown> };
      delete next.highlights;
      localStorage.setItem(storageKey, JSON.stringify(next));
    }
  } catch { /* Browser storage may be unavailable. */ }
}

export function loadPreferences(): AppPreferences {
  let stored: unknown;
  let legacyTheme: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    legacyTheme = localStorage.getItem('lingo-theme');
  } catch {
    return { ...defaults };
  }
  const value = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown> : {};
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
    nickWidth: typeof value.nickWidth === 'number' && Number.isInteger(value.nickWidth)
      && value.nickWidth >= minNickWidth && value.nickWidth <= maxNickWidth ? value.nickWidth : defaults.nickWidth,
    sidebarWidth: typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
      ? clampSidebarWidth(value.sidebarWidth) : defaults.sidebarWidth,
    sidebarCollapsed: typeof value.sidebarCollapsed === 'boolean' ? value.sidebarCollapsed : defaults.sidebarCollapsed,
    browserNotifications: typeof value.browserNotifications === 'boolean' ? value.browserNotifications : defaults.browserNotifications,
    notificationSound: typeof value.notificationSound === 'boolean' ? value.notificationSound : defaults.notificationSound,
  };
}

export function savePreferences(preferences: AppPreferences): void {
  try {
    // Preserve unsent legacy highlights until the first account bootstrap migrates them.
    let stored: unknown;
    try { stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { stored = null; }
    const legacy = stored && typeof stored === 'object' && !Array.isArray(stored)
      && Object.hasOwn(stored, 'highlights') ? { highlights: (stored as Record<string, unknown>).highlights } : {};
    localStorage.setItem(storageKey, JSON.stringify({ ...preferences, ...legacy }));
    localStorage.setItem('lingo-theme', preferences.theme);
  } catch { /* Browser storage may be unavailable. */ }
}

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(maxSidebarWidth, Math.max(minSidebarWidth, width)));
}

/** Theme, fonts, and layout sizes live on <html> so styles apply before and outside React. */
export function applyAppearance(preferences: AppPreferences): void {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  const stack = fontFamilies[preferences.fontFamily].stack;
  if (stack) root.style.setProperty('--mono', stack);
  else root.style.removeProperty('--mono');
  root.style.setProperty('--font-size', `${preferences.fontSize}px`);
  root.style.setProperty('--nick-width', `${preferences.nickWidth}ch`);
  if (preferences.sidebarWidth === null) root.style.removeProperty('--sidebar-width');
  else root.style.setProperty('--sidebar-width', `${preferences.sidebarWidth}px`);
}
