import type { CSSProperties, ReactNode } from 'react';

/** mIRC colors 0–98 (https://modern.ircdocs.horse/formatting#colors); 99 means the default color. */
const palette = [
  'ffffff', '000000', '00007f', '009300', 'ff0000', '7f0000', '9c009c', 'fc7f00',
  'ffff00', '00fc00', '009393', '00ffff', '0000fc', 'ff00ff', '7f7f7f', 'd2d2d2',
  '470000', '472100', '474700', '324700', '004700', '00472c', '004747', '002747', '000047', '2e0047', '470047', '47002a',
  '740000', '743a00', '747400', '517400', '007400', '007449', '007474', '004074', '000074', '4b0074', '740074', '740045',
  'b50000', 'b56300', 'b5b500', '7db500', '00b500', '00b571', '00b5b5', '0063b5', '0000b5', '7500b5', 'b500b5', 'b5006b',
  'ff0000', 'ff8c00', 'ffff00', 'b2ff00', '00ff00', '00ffa0', '00ffff', '008cff', '0000ff', 'a500ff', 'ff00ff', 'ff0098',
  'ff5959', 'ffb459', 'ffff71', 'cfff60', '6fff6f', '65ffc9', '6dffff', '59b4ff', '5959ff', 'c459ff', 'ff66ff', 'ff59bc',
  'ff9c9c', 'ffd39c', 'ffff9c', 'e2ff9c', '9cff9c', '9cffdb', '9cffff', '9cd3ff', '9c9cff', 'dc9cff', 'ff9cff', 'ff94d3',
  '000000', '131313', '282828', '363636', '4d4d4d', '656565', '818181', '9f9f9f', 'bcbcbc', 'e2e2e2', 'ffffff',
];

type Style = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  mono: boolean;
  reverse: boolean;
  fg: string | null;
  bg: string | null;
};

type Run = { start: number; end: number; style: Style };

export type Formatted = {
  /** The text with every formatting control code removed; offsets below refer to it. */
  plain: string;
  /** Styled stretches of `plain`; unstyled text is not listed. */
  runs: Run[];
};

const plainStyle: Style = { bold: false, italic: false, underline: false, strike: false, mono: false, reverse: false, fg: null, bg: null };
const toggles: Record<string, keyof Style> = { '\x02': 'bold', '\x1d': 'italic', '\x1f': 'underline', '\x1e': 'strike', '\x11': 'mono', '\x16': 'reverse' };
const controls = /[\x02\x03\x04\x0f\x11\x16\x1d\x1e\x1f]/;

function paletteColor(code: string | undefined): string | null | undefined {
  if (code === undefined) return undefined;
  const index = Number(code);
  return index < palette.length ? `#${palette[index]}` : null;
}

function styled(style: Style): boolean {
  return style.bold || style.italic || style.underline || style.strike || style.mono || style.reverse || !!style.fg || !!style.bg;
}

/** Split IRC text into plain text plus styled runs, following bold/italic/underline/strike/monospace/reverse/color codes. */
export function parseFormatting(text: string): Formatted {
  if (!controls.test(text)) return { plain: text, runs: [] };
  let plain = '';
  const runs: Run[] = [];
  let style = plainStyle;
  let runStart = 0;
  const setStyle = (next: Style) => {
    if (styled(style) && plain.length > runStart) runs.push({ start: runStart, end: plain.length, style });
    style = next;
    runStart = plain.length;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const toggle = toggles[char];
    if (toggle) {
      setStyle({ ...style, [toggle]: !style[toggle] });
      index += 1;
    } else if (char === '\x0f') {
      setStyle(plainStyle);
      index += 1;
    } else if (char === '\x03' || char === '\x04') {
      const pattern = char === '\x03' ? /^(\d{1,2})(?:,(\d{1,2}))?/ : /^([0-9a-f]{6})(?:,([0-9a-f]{6}))?/i;
      const match = pattern.exec(text.slice(index + 1, index + 15));
      if (!match) setStyle({ ...style, fg: null, bg: null });
      else if (char === '\x03') {
        const bg = paletteColor(match[2]);
        setStyle({ ...style, fg: paletteColor(match[1]) ?? null, bg: bg === undefined ? style.bg : bg });
      } else setStyle({ ...style, fg: `#${match[1]}`, bg: match[2] ? `#${match[2]}` : style.bg });
      index += 1 + (match?.[0].length ?? 0);
    } else {
      const next = text.slice(index).search(controls);
      const end = next < 0 ? text.length : index + next;
      plain += text.slice(index, end);
      index = end;
    }
  }
  setStyle(plainStyle);
  return { plain, runs };
}

/** http(s) URLs, minus trailing sentence punctuation and an unbalanced closing parenthesis. */
export function linkRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    let url = match[0].replace(/[.,;:!?]+$/, '');
    while (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
    if (!/^https?:\/\/[^/]/i.test(url)) continue;
    ranges.push({ start: match.index, end: match.index + url.length });
  }
  return ranges;
}

function runStyle(style: Style): { className?: string; style?: CSSProperties } {
  const className = [
    style.bold && 'irc-bold', style.italic && 'irc-italic', style.underline && 'irc-underline',
    style.strike && 'irc-strike', style.mono && 'irc-mono',
  ].filter(Boolean).join(' ') || undefined;
  let { fg, bg } = style;
  if (style.reverse) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--message-text)'];
  const css: CSSProperties = {};
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  return { className, style: fg || bg ? css : undefined };
}

/** The same text keeping bold/italic/underline/strike/monospace but dropping colors and reverse video. */
export function withoutColors(formatted: Formatted): Formatted {
  return {
    plain: formatted.plain,
    runs: formatted.runs
      .map((run) => ({ ...run, style: { ...run.style, fg: null, bg: null, reverse: false } }))
      .filter((run) => styled(run.style)),
  };
}

/** Styled pieces of `plain` between `start` and `end`. */
function pieces(formatted: Formatted, start: number, end: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = start;
  for (const run of formatted.runs) {
    if (run.end <= start || run.start >= end) continue;
    const from = Math.max(run.start, start);
    const to = Math.min(run.end, end);
    if (from > cursor) nodes.push(formatted.plain.slice(cursor, from));
    nodes.push(<span key={from} {...runStyle(run.style)}>{formatted.plain.slice(from, to)}</span>);
    cursor = to;
  }
  if (cursor < end) nodes.push(formatted.plain.slice(cursor, end));
  return nodes;
}

/**
 * Render parsed IRC text: formatting runs, optional mention marks (offsets into `plain`), and optional clickable links.
 * Links win over mentions that overlap them.
 */
export function renderFormatted(formatted: Formatted, options: {
  mentions?: { start: number; end: number }[];
  links?: boolean;
} = {}): ReactNode[] {
  const links = options.links ? linkRanges(formatted.plain).map((range) => ({ ...range, link: true })) : [];
  const marks = [...links, ...(options.mentions ?? []).map((range) => ({ ...range, link: false }))
    .filter((mention) => !links.some((link) => mention.start < link.end && link.start < mention.end))]
    .sort((left, right) => left.start - right.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    nodes.push(...pieces(formatted, cursor, mark.start));
    const content = pieces(formatted, mark.start, mark.end);
    nodes.push(mark.link
      ? <a key={`link-${mark.start}`} className="irc-link" href={formatted.plain.slice(mark.start, mark.end)} target="_blank"
        rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}>{content}</a>
      : <mark key={`mention-${mark.start}`} className="mention-token">{content}</mark>);
    cursor = mark.end;
  }
  nodes.push(...pieces(formatted, cursor, formatted.plain.length));
  return nodes;
}
