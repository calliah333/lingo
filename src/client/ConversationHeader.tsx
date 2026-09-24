import { useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import type { ChatBuffer, Network } from '../shared/contracts';
import { errorText } from './api';
import Icon from './Icon';
import { parseFormatting, renderFormatted } from './ircFormat';
import PaneHeader from './PaneHeader';

type ConversationHeaderProps = {
  buffer: ChatBuffer;
  network: Network;
  /** Live channel topic: null while unknown, '' when the server reports none. */
  topic: string | null;
  userCount: number | null;
  /** Topic edits need a joined channel on a connected network. */
  canEditTopic: boolean;
  editingTopic: boolean;
  usersOpen: boolean;
  menuOpen: boolean;
  onEditTopic: () => void;
  onCancelTopic: () => void;
  onSaveTopic: (topic: string) => Promise<void>;
  onToggleUsers: () => void;
  onSearch: () => void;
  onMenu: (event: MouseEvent<HTMLElement>) => void;
};

function TopicEditor({ channel, initial, onSave, onCancel }: {
  channel: string;
  initial: string;
  onSave: (topic: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(errorText(saveError));
      setSaving(false);
    }
  }

  return <form className="topic-editor" onSubmit={(event) => void submit(event)}>
    <label className="sr-only" htmlFor="channel-topic-input">Topic for {channel}</label>
    <input id="channel-topic-input" autoFocus value={draft} placeholder="Set a topic" disabled={saving}
      onChange={(event) => setDraft(event.target.value)} />
    <button className="button button-primary button-small" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    <button className="button button-quiet button-small" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
    {error && <span className="error-text" role="alert">{error}</span>}
  </form>;
}

export default function ConversationHeader({
  buffer, network, topic, userCount, canEditTopic, editingTopic, usersOpen, menuOpen,
  onEditTopic, onCancelTopic, onSaveTopic, onToggleUsers, onSearch, onMenu,
}: ConversationHeaderProps) {
  const [topicExpanded, setTopicExpanded] = useState(false);
  const channel = buffer.kind === 'channel';
  const title = buffer.kind === 'server' ? network.name : buffer.name.replace(/^#/, '');
  const formattedTopic = useMemo(() => parseFormatting(topic ?? ''), [topic]);

  const subtitle = channel && editingTopic
    ? <TopicEditor channel={buffer.name} initial={topic ?? ''} onSave={onSaveTopic} onCancel={onCancelTopic} />
    : channel
      ? topic
        // Not a <button>: the topic holds links, which cannot nest inside one.
        ? <div role="button" tabIndex={0} className={`conversation-topic${topicExpanded ? ' is-expanded' : ''}`}
          title={topicExpanded ? undefined : formattedTopic.plain} aria-expanded={topicExpanded}
          onClick={() => setTopicExpanded((expanded) => !expanded)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            setTopicExpanded((expanded) => !expanded);
          }}
          onDoubleClick={() => { if (canEditTopic) onEditTopic(); }}>{renderFormatted(formattedTopic, { links: true })}</div>
        : topic === '' && canEditTopic
          ? <button type="button" className="text-button conversation-topic-empty" onClick={onEditTopic}>Set a topic</button>
          : null
      : <span className="conversation-kind">
        {buffer.kind === 'query' ? 'Direct message' : `${network.host}:${network.port}${network.tls ? ' · TLS' : ''}`}
      </span>;

  return <PaneHeader className="conversation-header" titleId="conversation-title"
    title={<>{buffer.kind !== 'server' && <Icon name={channel ? 'hash' : 'at'} className="conversation-title-icon" />}
      <span>{title}</span></>}
    subtitle={subtitle}
    actions={<>
      {channel && canEditTopic && !editingTopic && <button className="icon-button conversation-edit-topic" type="button"
        aria-label="Edit topic" title="Edit topic" onClick={onEditTopic}><Icon name="pencil" /></button>}
      <button className="icon-button" type="button" aria-label={`Search ${buffer.name}`} title="Search this conversation"
        onClick={onSearch}><Icon name="search" /></button>
      {channel && <button className="icon-button conversation-users-toggle" type="button" aria-pressed={usersOpen}
        aria-controls="channel-users" aria-label={usersOpen ? 'Hide users' : 'Show users'}
        title={usersOpen ? 'Hide users' : 'Show users'} onClick={onToggleUsers}>
        <Icon name="users" />{userCount !== null && <span className="conversation-users-count">{userCount}</span>}
      </button>}
      <button className="icon-button" type="button" aria-label={`${buffer.kind === 'server' ? network.name : buffer.name} actions`}
        title="More actions" aria-haspopup="menu" aria-expanded={menuOpen}
        onPointerDown={(event) => { if (menuOpen) event.stopPropagation(); }} onClick={onMenu}><Icon name="more" /></button>
    </>} />;
}
