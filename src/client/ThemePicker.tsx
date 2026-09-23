export type Theme = 'dark' | 'light' | 'gruber';

type ThemePickerProps = {
  theme: Theme;
  onChange: (theme: Theme) => void;
};

export default function ThemePicker({ theme, onChange }: ThemePickerProps) {
  return (
    <label className="theme-picker">
      <span className="theme-picker__label">Theme</span>
      <select value={theme} onChange={(event) => onChange(event.target.value as Theme)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="gruber">Gruber Darker</option>
      </select>
    </label>
  );
}
