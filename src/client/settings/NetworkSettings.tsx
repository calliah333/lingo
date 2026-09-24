import { useEffect, useState, type FormEvent } from 'react';
import type { Network, NetworkInput } from '../../shared/contracts';
import { errorText } from '../api';
import Icon from '../Icon';
import PaneHeader from '../PaneHeader';
import { SettingsCard, SettingsDisclosure, SettingsField, SettingsToggle } from './SettingsControls';

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
  relayNicks: string;
  mentionAliases: string;
  displayNames: string;
};

type Sections = { connection: boolean; sasl: boolean; advanced: boolean };

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
  relayNicks: '',
  mentionAliases: '',
  displayNames: '',
});

/** Optional sections start open when the network already uses them. */
function openSections(network: Network | null): Sections {
  return {
    connection: Boolean(network && (network.autojoin.length || network.commands.length)),
    sasl: Boolean(network?.saslAccount),
    advanced: Boolean(network && (
      network.relayNicks.length || network.mentionAliases.length || Object.keys(network.displayNames).length
    )),
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseDisplayNames(value: string): Record<string, string> | string {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf('=');
    if (separator < 0 || line.indexOf('=', separator + 1) >= 0) {
      return `Display name line ${index + 1} must use ircNick = Friendly name.`;
    }
    const source = line.slice(0, separator).trim();
    const label = line.slice(separator + 1).trim();
    if (!source || !label) {
      return `Display name line ${index + 1} needs both an IRC nickname and a friendly name.`;
    }
    const key = source.toLowerCase();
    if (seen.has(key)) {
      return `Display name nickname "${source}" is listed more than once.`;
    }
    seen.add(key);
    entries.push([source, label]);
    if (seen.size > 100) return 'Enter no more than 100 display name overrides.';
  }
  return Object.fromEntries(entries);
}

export default function NetworkSettings({
  network,
  onSave,
  onDelete,
  onClose,
}: NetworkSettingsProps) {
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [open, setOpen] = useState<Sections>(() => openSections(network));
  const [validationError, setValidationError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);

  useEffect(() => {
    setOpen(openSections(network));
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
      relayNicks: network.relayNicks.join('\n'),
      mentionAliases: network.mentionAliases.join('\n'),
      displayNames: Object.entries(network.displayNames).map(([source, label]) => `${source} = ${label}`).join('\n'),
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

    const displayNames = parseDisplayNames(fields.displayNames);
    if (typeof displayNames === 'string') {
      setOpen((current) => ({ ...current, advanced: true }));
      setValidationError(displayNames);
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
      relayNicks: lines(fields.relayNicks),
      mentionAliases: lines(fields.mentionAliases),
      displayNames,
      ...(fields.saslPassword ? { saslPassword: fields.saslPassword } : {}),
    };
    try {
      await onSave(input, network?.id);
    } catch (error) {
      setSaveError(errorText(error));
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
      setDeleteError(errorText(error));
    } finally {
      setPending(null);
    }
  }

  const optional = <span className="settings-label-note">(optional)</span>;

  return (
    <section className="network-settings" aria-labelledby="network-settings-title">
      <PaneHeader titleId="network-settings-title" title={network ? 'Edit network' : 'Add network'} overline={network?.name}
        actions={<button className="icon-button" type="button" onClick={onClose} aria-label="Close network settings" title="Close">
          <Icon name="x" />
        </button>} />
      <form className="network-settings__form" onSubmit={submit} noValidate>
        <div className="pane-body">
          <div className="settings-content">
            <SettingsCard title="Server" description="The IRC server Lingo connects to.">
              <div className="settings-form">
                <SettingsField label="Network name" htmlFor="network-name">
                  <input id="network-name" name="name" autoComplete="off" required value={fields.name}
                    placeholder="Libera.Chat" onChange={(event) => update('name', event.target.value)} />
                </SettingsField>
                <div className="settings-grid settings-grid--address">
                  <SettingsField label="Server host" htmlFor="network-host">
                    <input id="network-host" name="host" autoComplete="url" required value={fields.host}
                      placeholder="irc.libera.chat" spellCheck={false} autoCapitalize="none"
                      onChange={(event) => update('host', event.target.value)} />
                  </SettingsField>
                  <SettingsField label="Port" htmlFor="network-port">
                    <input id="network-port" name="port" type="number" min="1" max="65535" step="1" required value={fields.port}
                      onChange={(event) => update('port', event.target.value)} />
                  </SettingsField>
                </div>
              </div>
              <SettingsToggle id="network-tls" name="tls" label="Use TLS" help="Encrypts the connection to the server."
                checked={fields.tls} onChange={(checked) => update('tls', checked)} />
            </SettingsCard>
            <SettingsCard title="Identity" description="How you appear on this network.">
              <div className="settings-form">
                <SettingsField label="Nickname" htmlFor="network-nick">
                  <input id="network-nick" name="nick" autoComplete="username" required value={fields.nick}
                    spellCheck={false} autoCapitalize="none" onChange={(event) => update('nick', event.target.value)} />
                </SettingsField>
                <div className="settings-grid">
                  <SettingsField label={<>Username {optional}</>} htmlFor="network-username">
                    <input id="network-username" name="username" autoComplete="off" value={fields.username}
                      spellCheck={false} autoCapitalize="none" onChange={(event) => update('username', event.target.value)} />
                  </SettingsField>
                  <SettingsField label={<>Real name {optional}</>} htmlFor="network-realname">
                    <input id="network-realname" name="realname" autoComplete="name" value={fields.realname}
                      onChange={(event) => update('realname', event.target.value)} />
                  </SettingsField>
                </div>
              </div>
            </SettingsCard>
            <SettingsDisclosure title={<>Connection options {optional}</>}
              description="Channels to join and commands to run after connecting."
              open={open.connection} onToggle={(connection) => setOpen((current) => ({ ...current, connection }))}>
              <div className="settings-form">
                <SettingsField label="Autojoin channels" htmlFor="network-autojoin" helpId="autojoin-help"
                  help="One channel per line, for example #general.">
                  <textarea id="network-autojoin" name="autojoin" rows={3} value={fields.autojoin} className="settings-mono"
                    spellCheck={false} onChange={(event) => update('autojoin', event.target.value)} aria-describedby="autojoin-help" />
                </SettingsField>
                <SettingsField label="Registration commands" htmlFor="network-commands" helpId="commands-help"
                  help="Run after connecting, one IRC command per line.">
                  <textarea id="network-commands" name="commands" rows={3} value={fields.commands} className="settings-mono"
                    spellCheck={false} onChange={(event) => update('commands', event.target.value)} aria-describedby="commands-help" />
                </SettingsField>
              </div>
            </SettingsDisclosure>
            <SettingsDisclosure title={<>SASL authentication {optional}</>}
              description="Signs in to your services account while connecting."
              open={open.sasl} onToggle={(sasl) => setOpen((current) => ({ ...current, sasl }))}>
              <div className="settings-grid">
                <SettingsField label="SASL account" htmlFor="network-sasl-account">
                  <input id="network-sasl-account" name="saslAccount" autoComplete="off" value={fields.saslAccount}
                    spellCheck={false} autoCapitalize="none" onChange={(event) => update('saslAccount', event.target.value)} />
                </SettingsField>
                <SettingsField label="SASL password" htmlFor="network-sasl-password">
                  <input id="network-sasl-password" name="saslPassword" type="password" autoComplete="new-password"
                    value={fields.saslPassword} placeholder={network ? 'Leave blank to keep saved password' : ''}
                    onChange={(event) => update('saslPassword', event.target.value)} />
                </SettingsField>
              </div>
            </SettingsDisclosure>
            <SettingsDisclosure title="Advanced" description="Relay bridges, mention aliases, and display names."
              open={open.advanced} onToggle={(advanced) => setOpen((current) => ({ ...current, advanced }))}>
              <div className="settings-form">
                <SettingsField label="Relay bridge nicknames" htmlFor="network-relay-nicks" helpId="relay-nicks-help"
                  help={<>One relay bot nickname per line. Relay messages appear as [username] message or &lt;username&gt; message.</>}>
                  <textarea id="network-relay-nicks" name="relayNicks" rows={3} value={fields.relayNicks} className="settings-mono"
                    spellCheck={false} onChange={(event) => update('relayNicks', event.target.value)} aria-describedby="relay-nicks-help" />
                </SettingsField>
                <SettingsField label="Mention aliases" htmlFor="network-mention-aliases" helpId="mention-aliases-help"
                  help="One name per line that should highlight you; include your bridge handle.">
                  <textarea id="network-mention-aliases" name="mentionAliases" rows={3} value={fields.mentionAliases}
                    className="settings-mono" spellCheck={false} onChange={(event) => update('mentionAliases', event.target.value)}
                    aria-describedby="mention-aliases-help" />
                </SettingsField>
                <SettingsField label="Display name overrides" htmlFor="network-display-names" helpId="display-names-help"
                  help="One override per line: ircNick = Friendly name.">
                  <textarea id="network-display-names" name="displayNames" rows={3} value={fields.displayNames}
                    className="settings-mono" spellCheck={false} onChange={(event) => update('displayNames', event.target.value)}
                    aria-describedby="display-names-help" />
                </SettingsField>
              </div>
            </SettingsDisclosure>
          </div>
        </div>
        <footer className="network-settings__footer">
          <div className="network-settings__footer-inner">
            {validationError && <p className="error-text" role="alert">{validationError}</p>}
            {saveError && <p className="error-text" role="alert">Could not save network: {saveError}</p>}
            {deleteError && <p className="error-text" role="alert">Could not delete network: {deleteError}</p>}
            <div className="network-settings__actions">
              {network && <button className="button button-danger" type="button" onClick={removeNetwork} disabled={pending !== null}>
                {pending === 'delete' ? 'Deleting…' : 'Delete network'}</button>}
              <div className="network-settings__primary">
                <button className="button button-quiet" type="button" onClick={onClose} disabled={pending !== null}>Cancel</button>
                <button className="button button-primary" type="submit" disabled={pending !== null}>
                  {pending === 'save' ? 'Saving…' : 'Save network'}</button>
              </div>
            </div>
          </div>
        </footer>
      </form>
    </section>
  );
}
