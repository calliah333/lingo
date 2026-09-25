import {
  useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent, type Ref,
} from 'react';
import type {
  ChannelListEntry, ChannelListPage, ChatBuffer, ChatMessage, MentionCandidate, Network, TypingState, UploadCapabilities,
  UploadExpiry,
} from '../shared/contracts';
import { displayIdentity } from '../shared/identity';
import { ApiError } from './api';
import { emojiContext, loadEmoji, loadedEmoji, matchEmoji, type Emoji } from './emoji';
import Icon from './Icon';
import {
  recentChannels, recentEmojis, recentMentions, rememberChannel, rememberEmoji, rememberMention, sessionStartedAt,
} from './sessionRecents';
import { TYPING_INTERVAL_MS, typingText } from './typing';
import { expiryLabels, formatBytes, postUpload, UploadCancelled } from './uploads';

/** Lets App hand in files dropped on the conversation pane. */
export type ComposerHandle = { upload(files: File[]): void };

type MentionComposerProps = {
  buffer: ChatBuffer;
  network: Network;
  /** The buffer's loaded messages; recent speakers rank first in mention suggestions. */
  messages: ChatMessage[];
  /** Your own names, never ranked as recent speakers. */
  ownNames: string[];
  disabled: boolean;
  autocomplete: boolean;
  /** Channel buffers already known on this network; offered first when they match. */
  knownChannels: string[];
  /** Changes while the network's channel list loads, so open suggestions refresh. */
  channelListUpdatedAt: number | null;
  /** Synced opt-in: tell others while you compose a message here. */
  sendTyping: boolean;
  /** Display names of others typing in this buffer. */
  typing: string[];
  onSend: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
  /** What this user may upload; the attach controls show only when `enabled`. `null` while unknown. */
  uploads: UploadCapabilities | null;
  /** This device's preferred expiry, used when the capabilities offer it. */
  uploadExpiry: UploadExpiry | null;
  onUploadExpiryChange: (expiry: UploadExpiry) => void;
  /** An upload was rejected with 400/413, so the limits may have changed; fetch the capabilities again. */
  onUploadLimitsChanged: () => void;
  ref?: Ref<ComposerHandle>;
};

type UploadProgress = { name: string; percent: number; queued: number };

type MentionContext = { kind: 'mention'; start: number; end: number; query: string };
type CommandContext = { kind: 'command'; end: number; query: string };
type ChannelContext = { kind: 'channel'; start: number; end: number; query: string };
type EmojiContext = { kind: 'emoji'; start: number; end: number; query: string };
type ChannelSuggestion = Pick<ChannelListEntry, 'name'> & Partial<ChannelListEntry>;

const CHANNEL_SUGGESTIONS = 20;
/** Ranked mention options shown at once; large channels send their whole roster. */
const MENTION_SUGGESTIONS = 50;
const EMOJI_SUGGESTIONS = 20;

/** Position in a most-recent-first list, or Infinity when absent, for ascending sorts. */
function recency(list: readonly string[], key: string): number {
  const index = list.indexOf(key);
  return index < 0 ? Infinity : index;
}

/** Sorts by the first differing key, each ascending. */
function byKeys<T>(keys: (item: T) => number[]): (left: T, right: T) => number {
  return (left, right) => {
    const a = keys(left);
    const b = keys(right);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    return 0;
  };
}

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

/** Checked after the others, so `/join` tokens stay channels and `@nick` stays a mention. */
function emojiShortcodeContext(value: string, caret: number): EmojiContext | null {
  const match = emojiContext(value, caret);
  return match && { kind: 'emoji', ...match };
}

export default function MentionComposer({
  buffer, network, messages, ownNames, disabled, autocomplete, knownChannels, channelListUpdatedAt, sendTyping, typing,
  onSend, onError, uploads, uploadExpiry, onUploadExpiryChange, onUploadLimitsChanged, ref,
}: MentionComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelListEntry[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [activeIndexState, setActiveIndex] = useState(0);
  const [emojiList, setEmojiList] = useState<Emoji[] | null>(loadedEmoji);
  // Enter only accepts a channel suggestion after arrow navigation; otherwise it sends what was typed.
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const listRequested = useRef(new Set<number>());
  /** Per buffer: when we last sent a notification, whether it was `active`, and a notification held back by the throttle. */
  const typingTargets = useRef(new Map<number, { at: number; active: boolean; timer?: number }>());
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Files waiting behind the current upload; uploads run one at a time. */
  const uploadQueue = useRef<File[]>([]);
  const uploadXhr = useRef<XMLHttpRequest | null>(null);
  const uploading = useRef(false);
  /** Bumped by Cancel and buffer switches, so an upload finishing just then does not insert its link. */
  const uploadGeneration = useRef(0);
  const upload = uploads?.enabled ? uploads : null;
  const expiry = upload && (uploadExpiry && upload.expiries.includes(uploadExpiry) ? uploadExpiry : upload.defaultExpiry);
  // The queue outlives the render that started it; it reads the current limits and expiry from here.
  const uploadState = useRef({ upload, expiry, disabled, onUploadLimitsChanged });
  uploadState.current = { upload, expiry, disabled, onUploadLimitsChanged };
  const context = mentionContext(value, caret) ?? commandContext(value, caret) ?? channelContext(value, caret)
    ?? emojiShortcodeContext(value, caret);
  const emojiQuery = context?.kind === 'emoji' ? context.query : '';
  const emojiOptions = useMemo(
    () => emojiList && emojiQuery ? matchEmoji(emojiList, emojiQuery, recentEmojis(), EMOJI_SUGGESTIONS) : [],
    [emojiList, emojiQuery],
  );
  // A `:word` with no matching emoji is ordinary text, so its menu stays closed and Enter sends.
  const menuOpen = !!context && !dismissed && !disabled && autocomplete
    && !(context.kind === 'emoji' && emojiList && !emojiOptions.length);
  const mentionOpen = menuOpen && context.kind === 'mention';
  const channelOpen = menuOpen && context.kind === 'channel';
  const emojiOpen = menuOpen && context.kind === 'emoji';
  const channelQuery = context?.kind === 'channel' ? context.query : '';
  const listId = `${context?.kind ?? 'mention'}-options-${buffer.id}`;
  const ownNamesKey = ownNames.join('\u0000').toLowerCase();
  /** Who spoke here, newest first: rank among speakers and whether it was during this page session. */
  const speakers = useMemo(() => {
    const own = new Set(ownNamesKey.split('\u0000'));
    const order = new Map<string, { rank: number; thisSession: boolean }>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.kind === 'system' || message.bufferId !== buffer.id) continue;
      const identity = displayIdentity(message, network.relayNicks ?? [], network.displayNames ?? {});
      const who = (identity.mentionTarget ?? identity.nick)?.toLowerCase();
      if (!who || own.has(who) || order.has(who)) continue;
      order.set(who, { rank: order.size, thisSession: message.time >= sessionStartedAt });
    }
    return order;
  }, [messages, buffer.id, network.relayNicks, network.displayNames, ownNamesKey]);
  // Ranking: exact match, people you mentioned this session, people talking this session, prefix matches,
  // earlier speakers, then the server's order.
  const filtered = useMemo(() => {
    if (context?.kind !== 'mention') return [];
    const query = context.query.toLocaleLowerCase();
    const mentioned = recentMentions(buffer.networkId);
    return candidates.flatMap((candidate, index) => {
      const name = candidate.name.toLocaleLowerCase();
      const mention = candidate.mention.toLocaleLowerCase();
      if (!name.includes(query) && !mention.includes(query)) return [];
      const spoke = speakers.get(mention);
      return [{ candidate, keys: [
        query !== '' && (name === query || mention === query) ? 0 : 1,
        recency(mentioned, mention),
        spoke?.thisSession ? spoke.rank : Infinity,
        name.startsWith(query) || mention.startsWith(query) ? 0 : 1,
        spoke ? spoke.rank : Infinity,
        index,
      ] }];
    }).sort(byKeys((item) => item.keys)).slice(0, MENTION_SUGGESTIONS).map((item) => item.candidate);
  }, [candidates, context?.kind, context?.query, speakers, buffer.networkId]);
  const matchingCommands = context?.kind === 'command'
    ? commands.filter((command) => command.name.startsWith(context.query.toLowerCase()))
    : [];
  // Ranking: the exact typed name, channels you joined or talked in this session, your channels, then the
  // network list (already ordered by users); prefix matches before substring matches within each group.
  const channelOptions = useMemo(() => {
    if (!channelOpen) return [];
    const needle = channelQuery.toLowerCase();
    const listed = new Map(channels.map((channel) => [channel.name.toLowerCase(), channel]));
    const known = new Set(knownChannels.map((name) => name.toLowerCase()));
    const recent = recentChannels(buffer.networkId);
    const options = new Map<string, ChannelSuggestion>();
    const add = (name: string) => {
      const key = name.toLowerCase();
      if (!options.has(key)) options.set(key, listed.get(key) ?? { name });
    };
    if (listed.has(needle) || known.has(needle)) add(channelQuery);
    // Known names first so a recent channel keeps its real casing.
    for (const name of [...knownChannels, ...recent]) if (name.toLowerCase().includes(needle)) add(name);
    for (const channel of channels) add(channel.name);
    return [...options.entries()].map(([key, option], index) => ({ option, keys: [
      needle !== '' && key === needle ? 0 : 1,
      recency(recent, key),
      known.has(key) ? 0 : 1,
      key.startsWith(needle) || key.slice(1).startsWith(needle.replace(/^[#&+!]/, '')) ? 0 : 1,
      index,
    ] })).sort(byKeys((item) => item.keys)).slice(0, CHANNEL_SUGGESTIONS).map((item) => item.option);
  }, [channelOpen, channelQuery, channels, knownChannels, buffer.networkId]);
  const optionCount = context?.kind === 'mention' ? filtered.length
    : context?.kind === 'channel' ? channelOptions.length
    : context?.kind === 'emoji' ? emojiOptions.length : matchingCommands.length;
  const activeIndex = Math.min(activeIndexState, Math.max(optionCount - 1, 0));
  const activeOptionId = menuOpen && optionCount ? `${listId}-${activeIndex}` : undefined;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({ upload: uploadFiles }));

  useEffect(() => {
    if (!emojiOpen || emojiList) return;
    let current = true;
    loadEmoji().then((list) => {
      if (current) setEmojiList(list);
    }).catch((error: unknown) => {
      if (current) onErrorRef.current(error);
    });
    return () => { current = false; };
  }, [emojiOpen, emojiList]);

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

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
    // Switching buffers discards the draft, which clears it for everyone watching us type; uploads meant for it stop.
    return () => {
      signalTyping(buffer.id, 'done');
      cancelUploads();
    };
  }, [buffer.id]);

  useEffect(() => {
    setActiveIndex(0);
    setNavigated(false);
  }, [context?.kind, context?.query, context && 'start' in context ? context.start : undefined]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) {
      // Grow with wrapped and multiline drafts; CSS caps the height and scrolls beyond it.
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    }
    if (pendingCaret.current === null) return;
    const position = pendingCaret.current;
    pendingCaret.current = null;
    input?.setSelectionRange(position, position);
  }, [value]);

  function updateCaret(input: HTMLTextAreaElement) {
    if (input.selectionStart !== input.selectionEnd) return;
    setCaret(input.selectionStart ?? input.value.length);
  }
  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.currentTarget.value);
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
    setDismissed(false);
    noteTyping(event.currentTarget.value);
  }

  /** IRCv3 `+typing`: `active` while composing a message (not a slash command), `done` once when cleared unsent. */
  function noteTyping(text: string) {
    if (!sendTyping || buffer.kind === 'server') return;
    const composing = !!text.trim() && (!text.startsWith('/') || /^\/(?:\/|me\s)/i.test(text));
    signalTyping(buffer.id, composing ? 'active' : 'done');
  }

  /** Sends at most one notification per target every 3 s; a held-back change is sent when the window ends. */
  function signalTyping(bufferId: number, state: Exclude<TypingState, 'paused'>) {
    const targets = typingTargets.current;
    const target = targets.get(bufferId) ?? { at: -Infinity, active: false };
    targets.set(bufferId, target);
    window.clearTimeout(target.timer);
    target.timer = undefined;
    if (state === 'done' && !target.active) return;
    const post = () => {
      target.at = Date.now();
      target.active = state === 'active';
      target.timer = undefined;
      void fetch(`/api/buffers/${bufferId}/typing`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }),
      }).catch(() => { /* Typing notices are best effort. */ });
    };
    const wait = target.at + TYPING_INTERVAL_MS - Date.now();
    // Continued typing refreshes `active` once the window ends.
    if (wait <= 0) post();
    else if (state === 'done' || !target.active) target.timer = window.setTimeout(post, wait);
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

  function chooseEmoji(emoji: Emoji) {
    if (context?.kind !== 'emoji') return;
    const insertion = `${emoji.emoji} `;
    const next = value.slice(0, context.start) + insertion + value.slice(context.end);
    const nextCaret = context.start + insertion.length;
    rememberEmoji(emoji.emoji);
    setValue(next);
    setCaret(nextCaret);
    pendingCaret.current = nextCaret;
    setDismissed(true);
    inputRef.current?.focus();
  }

  /** Checks sizes, then queues the files; oversized ones are reported and skipped. */
  function uploadFiles(files: File[]) {
    const { upload: limits, disabled: off } = uploadState.current;
    if (!limits || off || !files.length) return;
    const tooLarge = files.filter((file) => file.size > limits.maxBytes);
    if (tooLarge.length) {
      const names = tooLarge.map((file) => `${file.name || 'The pasted file'} (${formatBytes(file.size)})`).join(', ');
      onErrorRef.current(new Error(`${names} ${tooLarge.length === 1 ? 'is' : 'are'} larger than the ${formatBytes(limits.maxBytes)} upload limit.`));
    }
    uploadQueue.current.push(...files.filter((file) => file.size <= limits.maxBytes));
    if (!uploading.current) void drainUploads();
    else setProgress((current) => current && { ...current, queued: uploadQueue.current.length });
  }

  async function drainUploads() {
    uploading.current = true;
    for (let file = uploadQueue.current.shift(); file; file = uploadQueue.current.shift()) {
      const { expiry: chosen } = uploadState.current;
      if (!chosen) break; // Uploads were turned off meanwhile.
      const name = file.name || 'pasted file';
      const xhr = new XMLHttpRequest();
      const generation = uploadGeneration.current;
      uploadXhr.current = xhr;
      setProgress({ name, percent: 0, queued: uploadQueue.current.length });
      try {
        const record = await postUpload(file, chosen, xhr, (loaded, total) =>
          setProgress({ name, percent: Math.floor((loaded / total) * 100), queued: uploadQueue.current.length }));
        if (generation === uploadGeneration.current) insertLink(record.url);
      } catch (error) {
        if (error instanceof UploadCancelled || generation !== uploadGeneration.current) continue;
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 400 || status === 413) uploadState.current.onUploadLimitsChanged();
        onErrorRef.current(error);
        // Too large or refused by teacup concerns this file only; anything else would fail the rest too.
        if (status !== 413 && status !== 422) uploadQueue.current = [];
      } finally {
        uploadXhr.current = null;
      }
    }
    uploadQueue.current = [];
    uploading.current = false;
    setProgress(null);
  }

  /** Cancel stops the current upload and drops the files queued behind it. */
  function cancelUploads() {
    uploadGeneration.current += 1;
    uploadQueue.current = [];
    uploadXhr.current?.abort();
  }

  /** Inserts the link at the caret, spaced from the text before it; the user sends it themselves. */
  function insertLink(url: string) {
    const input = inputRef.current;
    if (!input) return;
    const current = input.value;
    const at = input.selectionEnd ?? current.length;
    const before = current.slice(0, at);
    const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${url} `;
    const next = before + insertion + current.slice(at);
    setValue(next);
    setCaret(at + insertion.length);
    pendingCaret.current = at + insertion.length;
    noteTyping(next);
    input.focus();
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // Pasted screenshots and copied files upload; plain text pastes as usual.
    if (!upload || !event.clipboardData.files.length) return;
    event.preventDefault();
    uploadFiles([...event.clipboardData.files]);
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...event.currentTarget.files ?? []];
    // Clearing lets the same file be picked again.
    event.currentTarget.value = '';
    uploadFiles(files);
  }

  /** Feeds session ranking: `/join` targets, the channel you talked in, and the people you @mentioned. */
  function rememberSent(text: string) {
    const join = /^\/join\s+(\S+)/i.exec(text);
    if (join) {
      for (const name of join[1].split(',')) if (/^[#&+!]./.test(name)) rememberChannel(buffer.networkId, name);
      return;
    }
    if (text.startsWith('/') && !/^\/me\s/i.test(text)) return;
    if (buffer.kind === 'channel') rememberChannel(buffer.networkId, buffer.name);
    for (const match of text.matchAll(/(?:^|[\s([{])@([^\s@]+)/g)) {
      rememberMention(buffer.networkId, match[1].replace(/[.,:;!?)\]}]+$/, ''));
    }
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
    if (menuOpen && context?.kind === 'emoji' && emojiOptions.length) {
      chooseEmoji(emojiOptions[activeIndex]);
      return;
    }
    if (menuOpen && context?.kind === 'channel' && navigated && channelOptions.length) {
      chooseChannel(channelOptions[activeIndex]);
      return;
    }
    if (disabled || sendingRef.current) return;
    // IRC messages are single lines: each non-blank line goes out as its own message, in order.
    const lines = value.split(/\r\n|\r|\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 1) lines[0] = lines[0].trimStart();
    if (!lines.length) return;
    sendingRef.current = true;
    setSending(true);
    const bufferId = buffer.id;
    let sent = 0;
    try {
      for (const line of lines) {
        await onSend(line);
        sent += 1;
        rememberSent(line);
      }
    } catch (error) {
      onError(error);
    } finally {
      if (sent) {
        // The message itself ends our typing state for everyone; `done` is only for unsent drafts.
        const target = typingTargets.current.get(bufferId);
        if (target) {
          window.clearTimeout(target.timer);
          target.timer = undefined;
          target.active = false;
        }
        // A failed line stays in the composer with the ones after it; lines already sent are removed.
        const rest = lines.slice(sent).join('\n');
        setValue(rest);
        setCaret(rest.length);
        pendingCaret.current = rest.length;
        setDismissed(false);
      }
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (handleMenuKey(event)) return;
    // Enter sends; Shift+Enter starts a new line. IME composition keeps its own Enter.
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  /** Suggestion navigation; returns whether the key was handled. */
  function handleMenuKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    // Alt+↑/↓ switch buffers (App.tsx) even while suggestions are open.
    if (!menuOpen || (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (optionCount && event.key === 'ArrowDown') {
      event.preventDefault();
      setNavigated(true);
      setActiveIndex((index) => (index + 1) % optionCount);
      return true;
    }
    if (optionCount && event.key === 'ArrowUp') {
      event.preventDefault();
      setNavigated(true);
      setActiveIndex((index) => (index - 1 + optionCount) % optionCount);
      return true;
    }
    if (optionCount && (event.key === 'Enter' || event.key === 'Tab')) {
      if (context?.kind === 'channel' && event.key === 'Enter' && !navigated) return false;
      event.preventDefault();
      if (context?.kind === 'mention') choose(filtered[activeIndex]);
      else if (context?.kind === 'command') chooseCommand(matchingCommands[activeIndex]);
      else if (context?.kind === 'channel') chooseChannel(channelOptions[activeIndex]);
      else if (context?.kind === 'emoji') chooseEmoji(emojiOptions[activeIndex]);
      return true;
    }
    return false;
  }

  return <>
    {progress && <div className="conversation-bar upload-progress" role="status">
      <Icon name="paperclip" />
      <span className="upload-progress__text">
        <span className="upload-progress__name">{progress.percent < 100 ? 'Uploading' : 'Finishing'} {progress.name}</span>
        <span className="upload-progress__percent">{progress.percent}%{progress.queued ? ` · ${progress.queued} more` : ''}</span>
      </span>
      <span className="upload-progress__track" role="progressbar" aria-label={`Uploading ${progress.name}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
        <span className="upload-progress__fill" style={{ width: `${progress.percent}%` }} />
      </span>
      <button className="button button-small" type="button" onClick={cancelUploads}>Cancel</button>
    </div>}
    <form className={`composer${disabled ? ' is-disabled' : ''}`} onSubmit={submit}>
      <label className="sr-only" htmlFor={`message-input-${buffer.id}`}>Message to {buffer.name}</label>
      <div className="typing-indicator" aria-live="polite">{typingText(typing)}</div>
      <textarea
        id={`message-input-${buffer.id}`}
        ref={inputRef}
        className="composer__input"
        rows={1}
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
        onPaste={handlePaste}
        placeholder={buffer.kind === 'server' ? 'Type a /command' : `Message ${buffer.name}`}
        // Read-only rather than disabled while sending, so focus stays for the next message.
        readOnly={sending}
        disabled={disabled}
      />
      {menuOpen && <ul
        id={listId}
        className="mention-menu"
        role="listbox"
        aria-label={context.kind === 'command' ? 'Slash commands' : context.kind === 'channel' ? 'Channels'
          : context.kind === 'emoji' ? 'Emoji' : 'Mention participants'}
        aria-busy={(mentionOpen && loading) || (channelOpen && channelsLoading) || (emojiOpen && !emojiList)}
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
        </> : context.kind === 'emoji' ? <>
          {emojiOptions.map((emoji, index) => <li key={emoji.emoji} role="presentation">
            <button
              id={`${listId}-${index}`}
              className="mention-option emoji-option"
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseEmoji(emoji)}
            >
              <span className="emoji-option__glyph" aria-hidden="true">{emoji.emoji}</span>
              <span>:{emoji.names.find((name) => name.includes(emojiQuery.toLowerCase())) ?? emoji.names[0]}:</span>
            </button>
          </li>)}
          {!emojiList && <li className="mention-option" role="option" aria-selected="false">Loading emoji…</li>}
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
              <code>{command.usage}</code><span className="mention-option__help">{command.help}</span>
            </button>
          </li>)}
          {!matchingCommands.length && <li className="mention-option" role="option" aria-selected="false">No matching commands</li>}
        </>}
      </ul>}
      {upload && expiry && <>
        <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1} onChange={handleFiles} />
        <select className="composer__expiry" aria-label="Uploaded files expire after" title="Uploaded files expire after"
          value={expiry} disabled={disabled} onChange={(event) => onUploadExpiryChange(event.currentTarget.value as UploadExpiry)}>
          {upload.expiries.map((option) => <option key={option} value={option}>{expiryLabels[option]}</option>)}
        </select>
        <button className="composer__attach" type="button" disabled={disabled}
          aria-label="Attach files" title={`Attach files (up to ${formatBytes(upload.maxBytes)} each)`}
          onClick={() => fileInputRef.current?.click()}>
          <Icon name="paperclip" />
        </button>
      </>}
      <button className="composer__send" type="submit" disabled={disabled || sending || !value.trim()}
        aria-label={sending ? 'Sending…' : 'Send message'} title="Send (Enter)">
        <Icon name="send" />
      </button>
    </form>
  </>;
}

