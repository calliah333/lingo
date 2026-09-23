import { useEffect, useState, type FormEvent } from 'react';
import type { Network, NetworkInput } from '../shared/contracts';

type NetworkSettingsProps = {
  network: Network | null;
  onSave: (input: NetworkInput, id?: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
};

type Fields = {
  name: string;
  host: string;
  port: string;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  saslAccount: string;
  saslPassword: string;
  autojoin: string;
  commands: string;
};

const emptyFields = (): Fields => ({
  name: '',
  host: '',
  port: '6697',
  tls: true,
  nick: '',
  username: '',
  realname: '',
  saslAccount: '',
  saslPassword: '',
  autojoin: '',
  commands: '',
});

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function NetworkSettings({
  network,
  onSave,
  onDelete,
  onClose,
}: NetworkSettingsProps) {
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [validationError, setValidationError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);

  useEffect(() => {
    if (!network) {
      setFields(emptyFields());
      return;
    }
    setFields({
      name: network.name,
      host: network.host,
      port: String(network.port),
      tls: network.tls,
      nick: network.nick,
      username: network.username,
      realname: network.realname,
      saslAccount: network.saslAccount,
      saslPassword: '',
      autojoin: network.autojoin.join('\n'),
      commands: network.commands.join('\n'),
    });
  }, [network]);

  function update<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setValidationError('');
    setSaveError('');
    setDeleteError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const port = Number(fields.port);
    if (!fields.name.trim() || !fields.host.trim() || !fields.nick.trim()) {
      setValidationError('Network name, server host, and nickname are required.');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setValidationError('Enter a valid port between 1 and 65535.');
      return;
    }

    setValidationError('');
    setSaveError('');
    setDeleteError('');
    setPending('save');
    const input: NetworkInput = {
      name: fields.name.trim(),
      host: fields.host.trim(),
      port,
      tls: fields.tls,
      nick: fields.nick.trim(),
      username: fields.username.trim(),
      realname: fields.realname.trim(),
      saslAccount: fields.saslAccount.trim(),
      autojoin: lines(fields.autojoin),
      commands: lines(fields.commands),
      ...(fields.saslPassword ? { saslPassword: fields.saslPassword } : {}),
    };
    try {
      await onSave(input, network?.id);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function removeNetwork() {
    if (!network || pending) return;
    if (!window.confirm(`Delete ${network.name}? This cannot be undone.`)) return;

    setSaveError('');
    setDeleteError('');
    setPending('delete');
    try {
      await onDelete(network.id);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="settings-panel" aria-labelledby="network-settings-title">
      <header className="settings-header">
        <h2 id="network-settings-title">{network ? 'Edit network' : 'Add network'}</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close network settings">
          ×
        </button>
      </header>
      <form className="settings-form" onSubmit={submit} noValidate>
        <div className="settings-field">
          <label htmlFor="network-name">Network name</label>
          <input id="network-name" name="name" autoComplete="off" required value={fields.name} onChange={(event) => update('name', event.target.value)} />
        </div>
        <div className="settings-row">
          <div className="settings-field">
            <label htmlFor="network-host">Server host</label>
            <input id="network-host" name="host" autoComplete="url" required value={fields.host} onChange={(event) => update('host', event.target.value)} />
          </div>
          <div className="settings-field">
            <label htmlFor="network-port">Port</label>
            <input id="network-port" name="port" type="number" min="1" max="65535" step="1" required value={fields.port} onChange={(event) => update('port', event.target.value)} />
          </div>
        </div>
        <label className="settings-checkbox" htmlFor="network-tls">
          <input id="network-tls" name="tls" type="checkbox" checked={fields.tls} onChange={(event) => update('tls', event.target.checked)} />
          Use TLS
        </label>
        <div className="settings-field">
          <label htmlFor="network-nick">Nickname</label>
          <input id="network-nick" name="nick" autoComplete="username" required value={fields.nick} onChange={(event) => update('nick', event.target.value)} />
        </div>
        <div className="settings-row">
          <div className="settings-field">
            <label htmlFor="network-username">Username <span className="muted">(optional)</span></label>
            <input id="network-username" name="username" autoComplete="off" value={fields.username} onChange={(event) => update('username', event.target.value)} />
          </div>
          <div className="settings-field">
            <label htmlFor="network-realname">Real name <span className="muted">(optional)</span></label>
            <input id="network-realname" name="realname" autoComplete="name" value={fields.realname} onChange={(event) => update('realname', event.target.value)} />
          </div>
        </div>
        <fieldset className="settings-group">
          <legend>SASL authentication <span className="muted">(optional)</span></legend>
          <div className="settings-field">
            <label htmlFor="network-sasl-account">SASL account</label>
            <input id="network-sasl-account" name="saslAccount" autoComplete="off" value={fields.saslAccount} onChange={(event) => update('saslAccount', event.target.value)} />
          </div>
          <div className="settings-field">
            <label htmlFor="network-sasl-password">SASL password</label>
            <input id="network-sasl-password" name="saslPassword" type="password" autoComplete="new-password" value={fields.saslPassword} placeholder={network ? 'Leave blank to keep saved password' : ''} onChange={(event) => update('saslPassword', event.target.value)} />
          </div>
        </fieldset>
        <div className="settings-field">
          <label htmlFor="network-autojoin">Autojoin channels</label>
          <textarea id="network-autojoin" name="autojoin" rows={3} value={fields.autojoin} onChange={(event) => update('autojoin', event.target.value)} aria-describedby="autojoin-help" />
          <span className="settings-help" id="autojoin-help">One channel per line, for example #general.</span>
        </div>
        <div className="settings-field">
          <label htmlFor="network-commands">Registration commands</label>
          <textarea id="network-commands" name="commands" rows={3} value={fields.commands} onChange={(event) => update('commands', event.target.value)} aria-describedby="commands-help" />
          <span className="settings-help" id="commands-help">Run after connecting, one IRC command per line.</span>
        </div>
        {validationError && <p className="settings-error" role="alert">{validationError}</p>}
        {saveError && <p className="settings-error" role="alert">Could not save network: {saveError}</p>}
        {deleteError && <p className="settings-error" role="alert">Could not delete network: {deleteError}</p>}
        <div className="settings-actions">
          {network && <button className="button button-danger" type="button" onClick={removeNetwork} disabled={pending !== null}>{pending === 'delete' ? 'Deleting…' : 'Delete network'}</button>}
          <span className="settings-actions-spacer" />
          <button className="button" type="button" onClick={onClose} disabled={pending !== null}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={pending !== null}>{pending === 'save' ? 'Saving…' : 'Save network'}</button>
        </div>
      </form>
    </section>
  );
}
