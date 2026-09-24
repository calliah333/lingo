import { useEffect, useState } from 'react';
import type { SyncedSettings } from '../../shared/contracts';
import { api, errorText, isSessionExpired } from '../api';
import type { AppPreferences } from '../preferences';
import { currentPushSubscription, disablePush, enablePush } from '../push';
import { SettingsCard, SettingsStatus, SettingsToggle } from './SettingsControls';

type NotificationSettingsProps = {
  preferences: AppPreferences;
  update: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  settings: SyncedSettings;
  onSettingsChange: (patch: Partial<SyncedSettings>) => void;
  onEnableNotifications: () => Promise<void>;
  onSoundChange: (enabled: boolean) => void;
  onUnauthorized: () => void;
};

/** Browser notifications and sound on this device, plus Web Push for when no window is open. */
export default function NotificationSettings({
  preferences, update, settings, onSettingsChange, onEnableNotifications, onSoundChange, onUnauthorized,
}: NotificationSettingsProps) {
  const [notificationError, setNotificationError] = useState('');
  const [notificationPending, setNotificationPending] = useState(false);
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [pushPending, setPushPending] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushSuccess, setPushSuccess] = useState('');

  useEffect(() => {
    let active = true;
    void currentPushSubscription().then((subscription) => { if (active) setPushEnabled(subscription !== null); },
      () => { if (active) setPushEnabled(false); });
    return () => { active = false; };
  }, []);

  async function enableNotifications() {
    setNotificationPending(true);
    setNotificationError('');
    try {
      await onEnableNotifications();
    } catch (error) {
      setNotificationError(errorText(error));
    } finally {
      setNotificationPending(false);
    }
  }

  async function pushAction(action: () => Promise<void>) {
    setPushPending(true);
    setPushError('');
    setPushSuccess('');
    try {
      await action();
    } catch (error) {
      if (isSessionExpired(error)) onUnauthorized();
      setPushError(errorText(error));
    } finally {
      setPushEnabled(await currentPushSubscription().then((subscription) => subscription !== null, () => false));
      setPushPending(false);
    }
  }

  function sendTestPush() {
    return pushAction(async () => {
      await api<{ delivered: number }>('/api/push/test', { method: 'POST' });
      setPushSuccess('Test notification sent.');
    });
  }

  return <>
    <SettingsCard title="While Lingo is open" description="Alerts for mentions and private messages on this device.">
      <SettingsToggle label="Browser notifications" checked={preferences.browserNotifications} disabled={notificationPending}
        onChange={(checked) => checked ? void enableNotifications() : update('browserNotifications', false)} />
      {notificationError && <div className="settings-row"><p className="error-text" role="alert">{notificationError}</p></div>}
      <SettingsToggle label="Notification sound" checked={preferences.notificationSound} onChange={onSoundChange} />
    </SettingsCard>
    <SettingsCard title="Push notifications"
      description="Mentions and private messages are pushed while no Lingo window is open, even when the browser is closed.">
      <SettingsToggle label="Push notifications on this device" checked={pushEnabled === true}
        disabled={pushEnabled === null || pushPending}
        help="On iPhone and iPad, add Lingo to the home screen and enable push from there."
        onChange={(checked) => void pushAction(checked ? enablePush : disablePush)} />
      <SettingsToggle label="Include message text in pushes" checked={settings.pushIncludesText}
        help="When off, pushes only say who wrote, keeping message text off lock screens. Applies to all your devices."
        onChange={(checked) => onSettingsChange({ pushIncludesText: checked })} />
      <div className="settings-row">
        <div className="settings-form__actions">
          <button className="button" type="button" disabled={!pushEnabled || pushPending} onClick={() => void sendTestPush()}>
            Send test notification</button>
          {pushPending && <span role="status" className="settings-help">Working…</span>}
        </div>
        <SettingsStatus error={pushError} success={pushSuccess} />
      </div>
    </SettingsCard>
  </>;
}
