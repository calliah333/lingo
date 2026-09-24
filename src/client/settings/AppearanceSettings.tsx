import { useEffect, useState } from 'react';
import ThemePicker from '../ThemePicker';
import {
  fontFamilies, maxFontSize, maxNickWidth, minFontSize, minNickWidth, type AppPreferences, type FontFamily,
} from '../preferences';
import { SettingsCard, SettingsField, SettingsToggle } from './SettingsControls';

type AppearanceSettingsProps = {
  preferences: AppPreferences;
  update: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
};

/** A whole-number field that commits only in-range values and snaps back to the saved value on blur. */
function NumberSetting({ id, value, min, max, unit, onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <div className="settings-number">
    <input id={id} type="number" min={min} max={max} step={1} inputMode="numeric" value={draft}
      aria-describedby={`${id}-help`} aria-invalid={draft !== String(value) || undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number(event.target.value);
        if (event.target.value.trim() && Number.isInteger(next) && next >= min && next <= max) onChange(next);
      }}
      onBlur={() => setDraft(String(value))} />
    <span className="settings-number__unit">{unit}</span>
  </div>;
}

/** Device-local look of the app and its transcripts. */
export default function AppearanceSettings({ preferences, update }: AppearanceSettingsProps) {
  return <>
    <SettingsCard title="Theme" description="Appearance settings apply to this device only.">
      <div className="settings-row">
        <ThemePicker theme={preferences.theme} onChange={(theme) => update('theme', theme)} />
      </div>
    </SettingsCard>
    <SettingsCard title="Transcript">
      <SettingsField inline label="Message font" htmlFor="font-family" helpId="font-family-help"
        help="Applies to messages, nicknames, and channel names; the rest of the interface keeps the system font.">
        <select id="font-family" value={preferences.fontFamily} aria-describedby="font-family-help"
          onChange={(event) => update('fontFamily', event.target.value as FontFamily)}>
          {Object.entries(fontFamilies).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </SettingsField>
      <SettingsField inline label="Font size" htmlFor="font-size" helpId="font-size-help" help={`${minFontSize}–${maxFontSize} px`}>
        <NumberSetting id="font-size" value={preferences.fontSize} min={minFontSize} max={maxFontSize} unit="px"
          onChange={(size) => update('fontSize', size)} />
      </SettingsField>
      <SettingsField inline label="Nickname column width" htmlFor="nick-width" helpId="nick-width-help"
        help={`${minNickWidth}–${maxNickWidth} characters`}>
        <NumberSetting id="nick-width" value={preferences.nickWidth} min={minNickWidth} max={maxNickWidth} unit="characters"
          onChange={(width) => update('nickWidth', width)} />
      </SettingsField>
      <SettingsToggle label="Colored nicknames" checked={preferences.coloredNicknames}
        onChange={(checked) => update('coloredNicknames', checked)} />
    </SettingsCard>
    <SettingsCard title="Timestamps">
      <SettingsToggle label="Show seconds in timestamps" checked={preferences.showSeconds}
        onChange={(checked) => update('showSeconds', checked)} />
      <SettingsToggle label="Use 12-hour time" checked={preferences.twelveHour}
        onChange={(checked) => update('twelveHour', checked)} />
    </SettingsCard>
  </>;
}
