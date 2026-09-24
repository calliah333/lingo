import { useId } from 'react';
import Icon from './Icon';

export type Theme = 'dark' | 'light' | 'gruber';

type ThemePickerProps = {
  theme: Theme;
  onChange: (theme: Theme) => void;
  /** Small circular swatches in a row, for tight spots such as the sign-in screen. */
  compact?: boolean;
};

/** Preview colors mirror each theme's tokens in styles/tokens.css. */
const themes: Array<{
  value: Theme;
  label: string;
  colors: { bg: string; sidebar: string; accent: string; line: string; faint: string; border: string };
}> = [
  { value: 'dark', label: 'Dark',
    colors: { bg: '#11161b', sidebar: '#0c1014', accent: '#5fd3a2', line: '#d3dbe2', faint: '#66727e', border: '#2e3944' } },
  { value: 'light', label: 'Light',
    colors: { bg: '#ffffff', sidebar: '#f4f6f8', accent: '#0f7f58', line: '#1f2b36', faint: '#7d8893', border: '#cdd5dd' } },
  { value: 'gruber', label: 'Gruber Darker',
    colors: { bg: '#181818', sidebar: '#111111', accent: '#ffdd33', line: '#e4e4ef', faint: '#7a7a84', border: '#3d3d3d' } },
];

export default function ThemePicker({ theme, onChange, compact = false }: ThemePickerProps) {
  const name = useId();
  const labelId = `${name}-label`;
  return <div className={compact ? 'theme-picker theme-picker--compact' : 'theme-picker'} role="radiogroup" aria-labelledby={labelId}>
    <span className={compact ? 'theme-picker__label' : 'sr-only'} id={labelId}>Theme</span>
    {themes.map(({ value, label, colors }) => <label key={value} className="theme-picker__option" title={compact ? label : undefined}>
      <input className="theme-picker__input" type="radio" name={name} value={value} checked={theme === value}
        onChange={() => onChange(value)} />
      {compact
        ? <span className="theme-picker__swatch" aria-hidden="true"
          style={{ background: `linear-gradient(135deg, ${colors.sidebar} 0 50%, ${colors.accent} 50% 100%)`, borderColor: colors.border }} />
        : <span className="theme-picker__card">
          <span className="theme-picker__preview" aria-hidden="true" style={{ background: colors.bg, borderColor: colors.border }}>
            <span className="theme-picker__preview-sidebar" style={{ background: colors.sidebar, borderColor: colors.border }}>
              <span style={{ background: colors.accent }} />
              <span style={{ background: colors.faint }} />
              <span style={{ background: colors.faint }} />
            </span>
            <span className="theme-picker__preview-main">
              <span style={{ background: colors.line }} />
              <span style={{ background: colors.faint }} />
              <span style={{ background: colors.line }} />
              <span className="theme-picker__preview-composer" style={{ borderColor: colors.border }}>
                <span style={{ background: colors.accent }} />
              </span>
            </span>
          </span>
          <span className="theme-picker__name">
            {label}
            <Icon name="check" className="theme-picker__check" />
          </span>
        </span>}
      {compact && <span className="sr-only">{label}</span>}
    </label>)}
  </div>;
}
