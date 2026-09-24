import type { SyncedSettings } from '../shared/contracts';
import { clearLegacyHighlights, legacyHighlights } from './preferences';

export const defaultSyncedSettings: SyncedSettings = {
  highlights: [], mutedBuffers: [], mutedNetworks: [], hiddenBuffers: [], collapsedNetworks: [],
  pushIncludesText: false, sendTyping: false,
};

const legacyIdKeys = {
  mutedBuffers: 'lingo-muted-buffers',
  mutedNetworks: 'lingo-muted-networks',
  hiddenBuffers: 'lingo-hidden-buffers',
  collapsedNetworks: 'lingo-collapsed-networks',
} as const;

/** Positive integer ids stored as a JSON array in browser storage. */
export function savedIds(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

/** Settings a browser stored locally before they were synced through the server. */
export function legacySettings(): Partial<SyncedSettings> {
  const patch: Partial<SyncedSettings> = {};
  for (const [field, key] of Object.entries(legacyIdKeys) as [keyof typeof legacyIdKeys, string][]) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) patch[field] = [...new Set(value.filter((id): id is number =>
        Number.isSafeInteger(id) && id > 0))].slice(0, 1000);
    } catch { /* Ignore invalid legacy values. */ }
  }
  const highlights = legacyHighlights();
  if (highlights !== null) patch.highlights = highlights;
  return patch;
}

export function clearLegacySettings(): void {
  try {
    for (const key of Object.values(legacyIdKeys)) localStorage.removeItem(key);
    localStorage.removeItem('lingo-legacy-settings-owner');
  } catch { /* Browser storage may be unavailable. */ }
  clearLegacyHighlights();
}
