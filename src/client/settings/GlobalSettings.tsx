import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AccountUser, SyncedSettings, UploadCapabilities } from '../../shared/contracts';
import Icon, { type IconName } from '../Icon';
import PaneHeader from '../PaneHeader';
import type { AppPreferences } from '../preferences';
import AccountSettings from './AccountSettings';
import AppearanceSettings from './AppearanceSettings';
import KeyboardSettings from './KeyboardSettings';
import MessageSettings from './MessageSettings';
import NotificationSettings from './NotificationSettings';
import UploadsSettings from './UploadsSettings';
import UsersSettings from './UsersSettings';

type GlobalSettingsProps = {
  user: AccountUser;
  preferences: AppPreferences;
  settings: SyncedSettings;
  onSettingsChange: (patch: Partial<SyncedSettings>) => void;
  onChange: (preferences: AppPreferences) => void;
  onEnableNotifications: () => Promise<void>;
  onSoundChange: (enabled: boolean) => void;
  onClose: () => void;
  onUnauthorized: () => void;
  /** `null` until fetched; the Uploads tab and upload permissions show once uploads are configured. */
  uploads: UploadCapabilities | null;
  /** The current user's upload permission changed; fetch the capabilities again. */
  onUploadsChanged: () => void;
};

type Tab = 'appearance' | 'messages' | 'notifications' | 'keyboard' | 'account' | 'uploads' | 'users';
const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'messages', label: 'Messages', icon: 'message' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'keyboard', label: 'Keyboard', icon: 'keyboard' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'uploads', label: 'Uploads', icon: 'paperclip' },
  { id: 'users', label: 'Users', icon: 'users' },
];

/** The tab row turns horizontal (and scrollable) on narrow screens; see panels.css. */
const narrowLayout = '(max-width: 640px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowLayout).matches);
  useEffect(() => {
    const query = window.matchMedia(narrowLayout);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

export default function GlobalSettings({
  user, preferences, settings, onChange, onSettingsChange, onEnableNotifications, onSoundChange, onClose, onUnauthorized,
  uploads, onUploadsChanged,
}: GlobalSettingsProps) {
  // Users who lost permission can still delete what they uploaded, so only an unconfigured server hides the tab.
  const uploadsConfigured = uploads !== null && (uploads.enabled || uploads.reason !== 'not_configured');
  const visibleTabs = tabs.filter((tab) => (tab.id !== 'users' || user.isAdmin) && (tab.id !== 'uploads' || uploadsConfigured));
  const [active, setActive] = useState<Tab>('appearance');
  const selected = visibleTabs.some((tab) => tab.id === active) ? active : 'appearance';
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  // The narrow tab row scrolls sideways; keep the selected tab in view.
  useEffect(() => {
    const list = tabListRef.current;
    const button = document.getElementById(`settings-tab-${selected}`);
    if (!narrow || !list || !button) return;
    const bounds = list.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    if (box.left < bounds.left) list.scrollLeft -= bounds.left - box.left + 12;
    else if (box.right > bounds.right) list.scrollLeft += box.right - bounds.right + 12;
  }, [selected, narrow]);

  function update<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    onChange({ ...preferences, [key]: value });
  }

  function select(tab: Tab) {
    setActive(tab);
    bodyRef.current?.scrollTo({ top: 0 });
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const index = visibleTabs.findIndex((tab) => tab.id === selected);
    const last = visibleTabs.length - 1;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    const tab = visibleTabs[next]!.id;
    select(tab);
    document.getElementById(`settings-tab-${tab}`)?.focus();
  }

  const panels: Record<Tab, ReactNode> = {
    appearance: <AppearanceSettings preferences={preferences} update={update} />,
    messages: <MessageSettings preferences={preferences} update={update} settings={settings}
      onSettingsChange={onSettingsChange} onUnauthorized={onUnauthorized} />,
    notifications: <NotificationSettings preferences={preferences} update={update} settings={settings}
      onSettingsChange={onSettingsChange} onEnableNotifications={onEnableNotifications} onSoundChange={onSoundChange}
      onUnauthorized={onUnauthorized} />,
    keyboard: <KeyboardSettings />,
    account: <AccountSettings user={user} onUnauthorized={onUnauthorized} />,
    uploads: <UploadsSettings onUnauthorized={onUnauthorized} />,
    users: <UsersSettings onUnauthorized={onUnauthorized} uploadsConfigured={uploadsConfigured}
      onCanUploadChange={(userId) => { if (userId === user.id) onUploadsChanged(); }} />,
  };

  return <section className="settings-view" aria-labelledby="settings-title">
    <PaneHeader title="Settings" titleId="settings-title" actions={
      <button className="icon-button" type="button" aria-label="Close settings" title="Close" onClick={onClose}>
        <Icon name="x" />
      </button>} />
    <div className="settings-view__layout">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections" ref={tabListRef}
        aria-orientation={narrow ? 'horizontal' : 'vertical'} onKeyDown={moveFocus}>
        {visibleTabs.map((tab) => <button key={tab.id} className="settings-tab" type="button" role="tab"
          id={`settings-tab-${tab.id}`} aria-selected={tab.id === selected} aria-controls={`settings-section-${tab.id}`}
          tabIndex={tab.id === selected ? 0 : -1} onClick={() => select(tab.id)}>
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </button>)}
      </div>
      <div className="pane-body settings-view__body" ref={bodyRef}>
        {/* Every panel stays mounted so drafts and loaded data survive switching tabs. */}
        {visibleTabs.map((tab) => <div key={tab.id} className="settings-content" role="tabpanel"
          id={`settings-section-${tab.id}`} aria-labelledby={`settings-tab-${tab.id}`} hidden={tab.id !== selected}>
          {panels[tab.id]}
        </div>)}
      </div>
    </div>
  </section>;
}
