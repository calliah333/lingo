import { useId, type ReactNode } from 'react';
import Icon from '../Icon';

type SettingsCardProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons shown beside the title, such as Refresh. */
  actions?: ReactNode;
  children: ReactNode;
};

/** A titled group of settings rows. */
export function SettingsCard({ title, description, actions, children }: SettingsCardProps) {
  const titleId = useId();
  return <section className="settings-card" aria-labelledby={titleId}>
    <header className="settings-card__header">
      <div className="settings-card__heading">
        <h2 className="settings-card__title" id={titleId}>{title}</h2>
        {description && <p className="settings-card__description">{description}</p>}
      </div>
      {actions && <div className="settings-card__actions">{actions}</div>}
    </header>
    <div className="settings-card__body">{children}</div>
  </section>;
}

type SettingsDisclosureProps = {
  title: ReactNode;
  description?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
};

/** A settings card whose rows collapse behind its title. */
export function SettingsDisclosure({ title, description, open, onToggle, children }: SettingsDisclosureProps) {
  return <details className="settings-card settings-card--disclosure" open={open}
    onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary className="settings-card__header">
      <div className="settings-card__heading">
        <h2 className="settings-card__title">{title}</h2>
        {description && <p className="settings-card__description">{description}</p>}
      </div>
      <Icon name="chevronDown" className="settings-card__chevron" />
    </summary>
    <div className="settings-card__body">{children}</div>
  </details>;
}

type SettingsToggleProps = {
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  name?: string;
};

/** A labeled switch row; the whole row toggles the underlying checkbox. */
export function SettingsToggle({ label, help, checked, disabled, onChange, id, name }: SettingsToggleProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const helpId = `${baseId}-help`;
  return <label className={disabled ? 'settings-toggle settings-toggle--disabled' : 'settings-toggle'}>
    <span className="settings-toggle__text">
      <span className="settings-toggle__label" id={labelId}>{label}</span>
      {help && <span className="settings-help" id={helpId}>{help}</span>}
    </span>
    <input className="settings-switch" type="checkbox" role="switch" id={id} name={name} checked={checked}
      disabled={disabled} aria-labelledby={labelId} aria-describedby={help ? helpId : undefined}
      onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

type SettingsFieldProps = {
  label: ReactNode;
  htmlFor: string;
  help?: ReactNode;
  /** Id for the help text, for the control's `aria-describedby`. */
  helpId?: string;
  /** Places the control beside its label on wide screens (selects, short inputs). */
  inline?: boolean;
  children: ReactNode;
};

/** A labeled control: stacked (label, control, help) or, when inline, label and help beside the control. */
export function SettingsField({ label, htmlFor, help, helpId, inline, children }: SettingsFieldProps) {
  const labelElement = <label className="settings-field__label" htmlFor={htmlFor}>{label}</label>;
  const helpElement = help && <span className="settings-help" id={helpId}>{help}</span>;
  const control = <div className="settings-field__control">{children}</div>;
  return inline
    ? <div className="settings-field settings-field--inline">
      <div className="settings-field__text">{labelElement}{helpElement}</div>
      {control}
    </div>
    : <div className="settings-field">{labelElement}{control}{helpElement}</div>;
}

/** Outcome messages under a form. */
export function SettingsStatus({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return <div className="settings-status">
    {error && <p className="error-text" role="alert">{error}</p>}
    {success && <p className="success-text" role="status">{success}</p>}
  </div>;
}
