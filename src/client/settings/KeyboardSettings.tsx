import { Fragment } from 'react';
import { shortcuts } from '../shortcuts';
import { SettingsCard } from './SettingsControls';

/** The app-wide keyboard shortcuts; read-only. */
export default function KeyboardSettings() {
  return <SettingsCard title="Keyboard shortcuts"
    description="Buffer shortcuts also work while typing in the message box. Some browsers on Windows and Linux keep Alt+digit for switching tabs.">
    {shortcuts.map(({ keys, action }) => <div className="settings-shortcut" key={action}>
      <span>{action}</span>
      <span className="settings-shortcut__keys">
        {keys.map((key, index) => <Fragment key={key}>{index > 0 && '+'}<kbd>{key}</kbd></Fragment>)}
      </span>
    </div>)}
  </SettingsCard>;
}
