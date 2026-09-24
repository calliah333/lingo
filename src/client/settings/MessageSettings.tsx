import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SyncedSettings } from '../../shared/contracts';
import { api, errorText, isSessionExpired, json } from '../api';
import type { AppPreferences } from '../preferences';
import { SettingsCard, SettingsField, SettingsStatus, SettingsToggle } from './SettingsControls';

type MessageSettingsProps = {
  preferences: AppPreferences;
  update: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  settings: SyncedSettings;
  onSettingsChange: (patch: Partial<SyncedSettings>) => void;
  onUnauthorized: () => void;
};

/** What the transcript shows, highlight phrases, and the server-side away message. */
export default function MessageSettings({ preferences, update, settings, onSettingsChange, onUnauthorized }: MessageSettingsProps) {
  const [highlightDraft, setHighlightDraft] = useState(() => settings.highlights.join('\n'));
  const highlightEditing = useRef(false);
  const highlightDirty = useRef(false);
  const highlightTimer = useRef<number | undefined>(undefined);
  const highlightText = useRef(highlightDraft);
  const [away, setAway] = useState('');
  const [awayLoading, setAwayLoading] = useState(true);
  const [awaySaving, setAwaySaving] = useState(false);
  const [awayError, setAwayError] = useState('');
  const [awaySuccess, setAwaySuccess] = useState('');

  useEffect(() => {
    if (!highlightEditing.current) {
      highlightText.current = settings.highlights.join('\n');
      setHighlightDraft(highlightText.current);
    }
  }, [settings.highlights]);
  useEffect(() => () => {
    clearTimeout(highlightTimer.current);
  }, []);

  function commitHighlights() {
    highlightTimer.current = undefined;
    if (!highlightDirty.current) return;
    highlightDirty.current = false;
    onSettingsChange({ highlights: [...new Set(highlightText.current.split(/[,\n]/)
      .map((phrase) => phrase.trim()).filter(Boolean))] });
  }

  useEffect(() => {
    const controller = new AbortController();
    void api<{ message: string }>('/api/settings/away', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setAway(result.message); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          if (isSessionExpired(error)) onUnauthorized();
          setAwayError(errorText(error));
        }
      }).finally(() => { if (!controller.signal.aborted) setAwayLoading(false); });
    return () => controller.abort();
  }, []);

  async function saveAway(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (awaySaving) return;
    setAwaySaving(true);
    setAwayError('');
    setAwaySuccess('');
    try {
      const result = await api<{ message: string }>('/api/settings/away', json('PATCH', { message: away }));
      setAway(result.message);
      setAwaySuccess('Away message saved.');
    } catch (error) {
      if (isSessionExpired(error)) onUnauthorized();
      setAwayError(errorText(error));
    } finally {
      setAwaySaving(false);
    }
  }

  return <>
    <SettingsCard title="Chat">
      <SettingsField inline label="Status messages" htmlFor="status-messages" helpId="status-messages-help"
        help="Events such as joins, parts, quits, and nickname changes.">
        <select id="status-messages" value={preferences.statusMessages} aria-describedby="status-messages-help"
          onChange={(event) => update('statusMessages', event.target.value as AppPreferences['statusMessages'])}>
          <option value="inline">Show inline</option>
          <option value="compact">Compact</option>
          <option value="hidden">Hide</option>
        </select>
      </SettingsField>
      <SettingsToggle label="Show server MOTD" checked={preferences.showMotd}
        onChange={(checked) => update('showMotd', checked)} />
      <SettingsToggle label="Autocomplete mentions and commands" checked={preferences.autocomplete}
        onChange={(checked) => update('autocomplete', checked)} />
      <SettingsToggle label="Tell others when I'm typing" checked={settings.sendTyping}
        help="Sends IRCv3 typing notifications while you write a message, on servers that support them. Applies to all your devices."
        onChange={(checked) => onSettingsChange({ sendTyping: checked })} />
    </SettingsCard>
    <SettingsCard title="Highlights" description="Messages containing these phrases are highlighted like mentions of your nick. Synced to all your devices.">
      <SettingsField label="Custom highlight phrases" htmlFor="highlight-phrases" helpId="highlight-phrases-help"
        help="Case-insensitive literal phrases, separated by lines or commas. Mentions of your nick also count.">
        <textarea id="highlight-phrases" rows={4} value={highlightDraft} placeholder="One phrase per line"
          aria-describedby="highlight-phrases-help"
          onFocus={() => { highlightEditing.current = true; }}
          onBlur={() => {
            clearTimeout(highlightTimer.current);
            const changed = highlightDirty.current;
            commitHighlights();
            highlightEditing.current = false;
            if (!changed) {
              highlightText.current = settings.highlights.join('\n');
              setHighlightDraft(highlightText.current);
            }
          }}
          onChange={(event) => {
            highlightText.current = event.target.value;
            highlightDirty.current = true;
            setHighlightDraft(event.target.value);
            clearTimeout(highlightTimer.current);
            highlightTimer.current = window.setTimeout(commitHighlights, 450);
          }} />
      </SettingsField>
    </SettingsCard>
    <SettingsCard title="Away">
      <form className="settings-form" onSubmit={(event) => void saveAway(event)}>
        <SettingsField label="Away message" htmlFor="away-message" helpId="away-message-help"
          help="Saved on the server and used automatically when you disconnect. Leave blank to disable.">
          <input id="away-message" value={away} disabled={awayLoading || awaySaving} maxLength={300}
            aria-describedby="away-message-help" placeholder="Shown when no browser clients are connected"
            onChange={(event) => { setAway(event.target.value); setAwaySuccess(''); }} />
        </SettingsField>
        <div className="settings-form__actions">
          <button className="button button-primary" type="submit" disabled={awayLoading || awaySaving}>
            {awaySaving ? 'Saving…' : 'Save away message'}</button>
          {awayLoading && <span role="status" className="settings-help">Loading…</span>}
        </div>
        <SettingsStatus error={awayError} success={awaySuccess} />
      </form>
    </SettingsCard>
  </>;
}
