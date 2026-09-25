const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Label of the Ctrl/Cmd modifier on this platform. */
export const commandKey = isMac ? '⌘' : 'Ctrl';
const altKey = isMac ? '⌥' : 'Alt';

/** The app-wide keyboard shortcuts, as listed in Settings; `App.tsx` implements them. */
export const shortcuts: Array<{ keys: string[]; action: string }> = [
  { keys: [commandKey, 'K'], action: 'Jump to a conversation' },
  { keys: [commandKey, 'F'], action: 'Search messages' },
  { keys: [altKey, '↑ / ↓'], action: 'Previous or next conversation in the sidebar' },
  { keys: [altKey, 'Shift', '↑ / ↓'], action: 'Previous or next unread conversation, mentions first' },
  { keys: [altKey, '1 – 9'], action: 'Conversation by sidebar position' },
  { keys: ['/'], action: 'Start a command in the message box' },
  { keys: ['Shift', 'Enter'], action: 'New line in the message box; each line sends as its own message' },
  { keys: ['Esc'], action: 'Close the open menu, dialog, or panel; dismiss the "New messages" line' },
];
