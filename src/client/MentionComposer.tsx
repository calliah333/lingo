import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import type { ChannelListEntry, ChannelListPage, ChatBuffer, MentionCandidate } from '../shared/contracts';

type MentionComposerProps = {
  buffer: ChatBuffer;
  disabled: boolean;
  autocomplete: boolean;
  /** Channel buffers already known on this network; offered first when they match. */
  knownChannels: string[];
  /** Changes while the network's channel list loads, so open suggestions refresh. */
  channelListUpdatedAt: number | null;
  onSend: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
};

type MentionContext = { kind: 'mention'; start: number; end: number; query: string };
type CommandContext = { kind: 'command'; end: number; query: string };
type ChannelContext = { kind: 'channel'; start: number; end: number; query: string };
type ChannelSuggestion = Pick<ChannelListEntry, 'name'> & Partial<ChannelListEntry>;

const CHANNEL_SUGGESTIONS = 20;

const commands = [
  { name: 'join', usage: '/join #channel', help: 'Join a channel' },
  { name: 'part', usage: '/part [#channel]', help: 'Leave a channel' },
  { name: 'nick', usage: '/nick nickname', help: 'Change your nickname' },
  { name: 'me', usage: '/me action', help: 'Send an action' },
  { name: 'msg', usage: '/msg target message', help: 'Send a private message' },
  { name: 'notice', usage: '/notice target message', help: 'Send a notice' },
  { name: 'topic', usage: '/topic [#channel] [topic]', help: 'View or set the topic' },
  { name: 'list', usage: '/list [mask]', help: 'Open the channel list' },
] as const;

function mentionContext(value: string, caret: number): MentionContext | null {
  const beforeCaret = value.slice(0, caret);
  if (beforeCaret.startsWith('/')) return null;
  const match = /(?:^|[\s([{])@([^\s@]*)$/.exec(beforeCaret);
  if (!match) return null;
  const query = match[1];
  const start = caret - query.length - 1;
  return { kind: 'mention', start, end: caret, query };
}

function commandContext(value: string, caret: number): CommandContext | null {
  const match = /^\/([a-z]*)(?=\s|$)/i.exec(value);
  if (!match || caret < 1 || caret > match[0].length) return null;
  return { kind: 'command', end: match[0].length, query: value.slice(1, caret) };
}

/** The comma- or space-separated channel token under the caret in `/join #a,#b`. */
function channelContext(value: string, caret: number): ChannelContext | null {
  const match = /^\/join\s+/i.exec(value);
  if (!match || caret < match[0].length) return null;
  const before = value.slice(0, caret);
  const start = Math.max(before.lastIndexOf(','), before.search(/\s\S*$/)) + 1;
  const separator = value.slice(caret).search(/[\s,]/);
  const end = separator < 0 ? value.length : caret + separator;
  return { kind: 'channel', start, end, query: value.slice(start, caret) };
}

export default function MentionComposer({
  buffer, disabled, autocomplete, knownChannels, channelListUpdatedAt, onSend, onError,
}: MentionComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelListEntry[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [activeIndexState, setActiveIndex] = useState(0);
  // Enter only accepts a channel suggestion after arrow navigation; otherwise it sends what was typed.
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const listRequested = useRef(new Set<number>());
  const context = mentionContext(value, caret) ?? commandContext(value, caret) ?? channelContext(value, caret);
  const menuOpen = !!context && !dismissed && !disabled && autocomplete;
  const mentionOpen = menuOpen && context.kind === 'mention';
  const channelOpen = menuOpen && context.kind === 'channel';
  const channelQuery = context?.kind === 'channel' ? context.query : '';
  const listId = `${context?.kind ?? 'mention'}-options-${buffer.id}`;
  const filtered = useMemo(() => {
    if (context?.kind !== 'mention') return [];
    const query = context.query.toLocaleLowerCase();
    return candidates.filter((candidate) => candidate.name.toLocaleLowerCase().includes(query)
      || candidate.mention.toLocaleLowerCase().includes(query));
  }, [candidates, context?.kind, context?.query]);
  const matchingCommands = context?.kind === 'command'
    ? commands.filter((command) => command.name.startsWith(context.query.toLowerCase()))
    : [];
  const channelOptions = useMemo(() => {
    if (!channelOpen) return [];
    const needle = channelQuery.toLowerCase();
    const listed = new Map(channels.map((channel) => [channel.name.toLowerCase(), channel]));
    const options = new Map<string, ChannelSuggestion>();
    const add = (name: string) => {
      const key = name.toLowerCase();
      if (!options.has(key)) options.set(key, listed.get(key) ?? { name });
    };
    if (listed.has(needle) || knownChannels.some((name) => name.toLowerCase() === needle)) add(channelQuery);
    for (const name of knownChannels) if (name.toLowerCase().includes(needle)) add(name);
    for (const channel of channels) add(channel.name);
    return [...options.values()].slice(0, CHANNEL_SUGGESTIONS);
  }, [channelOpen, channelQuery, channels, knownChannels]);
  const optionCount = context?.kind === 'mention' ? filtered.length
    : context?.kind === 'channel' ? channelOptions.length : matchingCommands.length;
  const activeIndex = Math.min(activeIndexState, Math.max(optionCount - 1, 0));
  const activeOptionId = menuOpen && optionCount ? `${listId}-${activeIndex}` : undefined;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    function handleSlash() {
      if (disabled) return;
      if (!value) {
        setValue('/');
        setCaret(1);
        setDismissed(false);
        pendingCaret.current = 1;
      }
      inputRef.current?.focus();
    }
    window.addEventListener('lingo:slash', handleSlash);
    return () => window.removeEventListener('lingo:slash', handleSlash);
  }, [disabled, value]);

  useEffect(() => {
    if (!mentionOpen) {
      setCandidates([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setCandidates([]);
    setLoading(true);
    setActiveIndex(0);
    void fetch(`/api/buffers/${buffer.id}/participants`, {
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `Could not load participants (${response.status})`;
        throw new Error(message);
      }
      return response.json() as Promise<{ participants: MentionCandidate[] }>;
    }).then((body) => {
      if (!Array.isArray(body?.participants)) throw new Error('Invalid participants response');
      setCandidates(body.participants.filter((candidate): candidate is MentionCandidate =>
        !!candidate && typeof candidate.name === 'string' && typeof candidate.mention === 'string'));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) onErrorRef.current(error);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [buffer.id, mentionOpen]);

  useEffect(() => {
    if (!channelOpen) {
      setChannels([]);
      setChannelsLoading(false);
      return;
    }
    const controller = new AbortController();
    const networkId = buffer.networkId;
    setChannelsLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: channelQuery, limit: String(CHANNEL_SUGGESTIONS), names: '1' });
      void fetch(`/api/networks/${networkId}/channels?${params}`, { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Could not load channels (${response.status})`);
          const page = await response.json() as ChannelListPage;
          if (controller.signal.aborted) return;
          setChannels(page.channels);
          // Suggestions come from LIST; request it once when this network has none yet.
          if (page.state === 'idle' && !listRequested.current.has(networkId)) {
            listRequested.current.add(networkId);
            void fetch(`/api/networks/${networkId}/channels/refresh`, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' }, body: '{}',
            }).catch(() => { /* Known channels still suggest; the list is best effort. */ });
          }
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) onErrorRef.current(error);
        }).finally(() => {
          if (!controller.signal.aborted) setChannelsLoading(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [buffer.networkId, channelOpen, channelQuery, channelListUpdatedAt]);

  useEffect(() => {
    setValue('');
    setCaret(0);
    setCandidates([]);
    setDismissed(false);
  }, [buffer.id]);

  useEffect(() => {
    setActiveIndex(0);
    setNavigated(false);
  }, [context?.kind, context?.query, context?.kind === 'mention' || context?.kind === 'channel' ? context.start : undefined]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const position = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(position, position);
  }, [value]);

  function updateCaret(input: HTMLInputElement) {
    if (input.selectionStart !== input.selectionEnd) return;
    setCaret(input.selectionStart ?? input.value.length);
  }
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.currentTarget.value);
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
    setDismissed(false);
  }

  function choose(candidate: MentionCandidate) {
    if (context?.kind !== 'mention') return;
    const insertion = `@${candidate.mention} `;
    const next = value.slice(0, context.start) + insertion + value.slice(context.end);
    const nextCaret = context.start + insertion.length;
    setValue(next);
    setCaret(nextCaret);
    pendingCaret.current = nextCaret;
    setDismissed(true);
    inputRef.current?.focus();
  }

  function chooseCommand(command: typeof commands[number]) {
    if (context?.kind !== 'command') return;
    const insertion = `/${command.name} `;
    const next = insertion + value.slice(context.end);
    const nextCaret = insertion.length;
    setValue(next);
    setCaret(nextCaret);
    pendingCaret.current = nextCaret;
    setDismissed(true);
    inputRef.current?.focus();
  }

  function chooseChannel(channel: ChannelSuggestion) {
    if (context?.kind !== 'channel') return;
    const next = value.slice(0, context.start) + channel.name + value.slice(context.end);
    const nextCaret = context.start + channel.name.length;
    setValue(next);
    setCaret(nextCaret);
    pendingCaret.current = nextCaret;
    setDismissed(true);
    inputRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (menuOpen && context?.kind === 'mention' && filtered.length) {
      choose(filtered[activeIndex]);
      return;
    }
    if (menuOpen && context?.kind === 'command' && matchingCommands.length) {
      chooseCommand(matchingCommands[activeIndex]);
      return;
    }
    if (menuOpen && context?.kind === 'channel' && navigated && channelOptions.length) {
      chooseChannel(channelOptions[activeIndex]);
      return;
    }
    const text = value.trim();
    if (disabled || sendingRef.current || !text) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend(text);
      setValue('');
      setCaret(0);
      setDismissed(false);
    } catch (error) {
      onError(error);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!menuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (optionCount && event.key === 'ArrowDown') {
      event.preventDefault();
      setNavigated(true);
      setActiveIndex((index) => (index + 1) % optionCount);
      return;
    }
    if (optionCount && event.key === 'ArrowUp') {
      event.preventDefault();
      setNavigated(true);
      setActiveIndex((index) => (index - 1 + optionCount) % optionCount);
      return;
    }
    if (optionCount && (event.key === 'Enter' || event.key === 'Tab')) {
      if (context?.kind === 'channel' && event.key === 'Enter' && !navigated) return;
      event.preventDefault();
      if (context?.kind === 'mention') choose(filtered[activeIndex]);
      else if (context?.kind === 'command') chooseCommand(matchingCommands[activeIndex]);
      else if (context?.kind === 'channel') chooseChannel(channelOptions[activeIndex]);
    }
  }

  return <form className="composer" onSubmit={submit}>
    <span className="composer-prompt" aria-hidden="true">›</span>
    <label className="sr-only" htmlFor={`message-input-${buffer.id}`}>Message to {buffer.name}</label>
    <input
      id={`message-input-${buffer.id}`}
      ref={inputRef}
      type="text"
      role="combobox"
      aria-autocomplete={autocomplete ? 'list' : 'none'}
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={activeOptionId}
      autoComplete="off"
      value={value}
      onChange={handleChange}
      onClick={(event) => updateCaret(event.currentTarget)}
      onKeyUp={(event) => updateCaret(event.currentTarget)}
      onKeyDown={handleKeyDown}
      placeholder={buffer.kind === 'server' ? 'Type a command…' : `Message ${buffer.name} or /command…`}
      disabled={disabled || sending}
    />
    {menuOpen && <ul
      id={listId}
      className="mention-menu"
      role="listbox"
      aria-label={context.kind === 'command' ? 'Slash commands' : context.kind === 'channel' ? 'Channels' : 'Mention participants'}
      aria-busy={(mentionOpen && loading) || (channelOpen && channelsLoading)}
    >
      {context.kind === 'channel' ? <>
        {channelOptions.map((channel, index) => <li key={channel.name.toLowerCase()} role="presentation">
          <button
            id={`${listId}-${index}`}
            className="mention-option channel-option"
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => chooseChannel(channel)}
            title={channel.topic || undefined}
          >
            <strong>{channel.name}</strong>
            {channel.users !== undefined && <span className="channel-option__users">{channel.users.toLocaleString()} users</span>}
            {channel.topic && <span className="channel-option__topic">{channel.topic}</span>}
          </button>
        </li>)}
        {!channelOptions.length && <li className="mention-option" role="option" aria-selected="false">
          {channelsLoading ? 'Loading channels…' : 'No matching channels'}
        </li>}
      </> : context.kind === 'mention' ? <>
        {filtered.map((candidate, index) => <li key={`${candidate.mention.toLocaleLowerCase()}-${index}`} role="presentation">
          <button
            id={`${listId}-${index}`}
            className="mention-option"
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(candidate)}
          >
            {candidate.name}{candidate.name === candidate.mention ? '' : ` (@${candidate.mention})`}
          </button>
        </li>)}
        {!filtered.length && <li className="mention-option" role="option" aria-selected="false">
          {loading ? 'Loading participants…' : 'No matching participants'}
        </li>}
      </> : <>
        {matchingCommands.map((command, index) => <li key={command.name} role="presentation">
          <button
            id={`${listId}-${index}`}
            className="mention-option"
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => chooseCommand(command)}
          >
            <strong>{command.usage}</strong> — {command.help}
          </button>
        </li>)}
        {!matchingCommands.length && <li className="mention-option" role="option" aria-selected="false">No matching commands</li>}
      </>}
    </ul>}
    <button className="button button-primary send-button" type="submit" disabled={disabled || sending || !value.trim()}>
      {sending ? 'Sending…' : 'Send ↵'}
    </button>
  </form>;
}

