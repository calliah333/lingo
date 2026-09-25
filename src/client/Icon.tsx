/** Stroke icons drawn on a 24px grid; they inherit `currentColor` and scale with `font-size`. */
const paths = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  hash: <path d="M5 9h15M4 15h15M10 3.5 8 20.5M16 3.5l-2 17" />,
  at: <><circle cx="12" cy="12" r="3.8" /><path d="M15.8 12v1.4a2.6 2.6 0 0 0 5.2 0V12a9 9 0 1 0-3.6 7.2" /></>,
  server: <><rect x="4" y="4" width="16" height="6.5" rx="1.8" /><rect x="4" y="13.5" width="16" height="6.5" rx="1.8" /><path d="M8 7.25h.01M8 16.75h.01" /></>,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.7.8 2.7 2.5 3 5.2" /></>,
  bellOff: <><path d="M8.6 4.6A6 6 0 0 1 18 9.5c0 3.2.8 5.2 1.6 6.5H9" /><path d="M6.2 7.4C6.07 8.08 6 8.78 6 9.5c0 3.2-.8 5.2-1.6 6.5H14" /><path d="M10.3 20a2 2 0 0 0 3.4 0M3 3l18 18" /></>,
  rotate: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></>,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  logOut: <><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H16" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  pencil: <path d="M15.5 5.5l3 3M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" />,
  message: <path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20l1.1-4.4A7.5 7.5 0 1 1 20 12.5Z" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  bell: <><path d="M6 9.5a6 6 0 0 1 12 0c0 3.2.8 5.2 1.6 6.5H4.4C5.2 14.7 6 12.7 6 9.5Z" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c.7-4 3.6-6 7.5-6s6.8 2 7.5 6" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.8-.7 1.8-1.6 0-.5-.2-.9-.5-1.3s-.5-.8-.5-1.3c0-1 .8-1.7 1.8-1.7h2.1a3.8 3.8 0 0 0 3.8-3.8c0-4-3.8-7.3-8.5-7.3Z" /><circle cx="7.8" cy="11.5" r="1" /><circle cx="10.4" cy="7.6" r="1" /><circle cx="15" cy="8" r="1" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14.5h8" /></>,
  paperclip: <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
} as const;

export type IconName = keyof typeof paths;

export default function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

/** Lingo's mark: a speech bubble holding an IRC channel hash. `public/favicon.svg` and the PNG app icons draw the same shapes. */
export function Logo({ className }: { className?: string }) {
  return <svg className={className ? `logo ${className}` : 'logo'} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path className="logo__bubble"
      d="M20 6h24a14 14 0 0 1 14 14v14a14 14 0 0 1-14 14H23L10.6 57.3C8.6 58.8 6 57.4 6 55V20A14 14 0 0 1 20 6Z" />
    <path className="logo__hash" d="M27.5 16.5 24.5 37.5M39.5 16.5l-3 21M20 23.5h24.5M19 31h24.5" />
  </svg>;
}
