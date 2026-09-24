import type { ChatMessage, NetworkExportLine } from '../shared/contracts.ts';
import type { ExportScope, Store } from './store.ts';

export type ExportFormat = 'txt' | 'jsonl';

/** Rows fetched per query; exports stream page by page instead of loading a whole history. */
export const EXPORT_PAGE_SIZE = 1000;

const FORMATTING = /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-f]{6}(?:,[0-9a-f]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/gi;

/** One plain-text log line: mIRC formatting removed, always a single line. */
function textLine(message: ChatMessage): string {
  const time = new Date(message.time).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = message.text.replace(FORMATTING, '').replace(/[\r\n]+/g, ' ');
  if (message.nick === null || message.kind === 'system') return `[${time}] -- ${text}\n`;
  if (message.kind === 'action') return `[${time}] * ${message.nick} ${text}\n`;
  if (message.kind === 'notice') return `[${time}] -${message.nick}- ${text}\n`;
  return `[${time}] <${message.nick}> ${text}\n`;
}

/** An attachment filename safe for Content-Disposition: `<parts>-<yyyy-mm-dd>.<ext>` in plain ASCII. */
export function exportFilename(parts: string[], now: number, format: ExportFormat): string {
  const safe = parts.map(part => part.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '') || 'history');
  return `${[...safe, new Date(now).toISOString().slice(0, 10)].join('-')}.${format}`;
}

/**
 * Streams a buffer's or network's history in ascending id order, one page per pull.
 * JSONL lines are `ChatMessage`s; network exports add `bufferName` so lines stay attributable.
 */
export function exportResponse(
  store: Store,
  scope: ExportScope,
  format: ExportFormat,
  filename: string,
  range: { since?: number; until?: number },
): Response {
  const encoder = new TextEncoder();
  let afterId = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const rows = store.exportMessages(scope, afterId, EXPORT_PAGE_SIZE, range);
      if (rows.length > 0) {
        afterId = rows.at(-1)!.message.id;
        const lines = rows.map(({ message, bufferName }) => format === 'txt'
          ? textLine(message)
          : `${JSON.stringify('networkId' in scope ? { ...message, bufferName } satisfies NetworkExportLine : message)}\n`);
        controller.enqueue(encoder.encode(lines.join('')));
      }
      if (rows.length < EXPORT_PAGE_SIZE) controller.close();
    },
  }, { highWaterMark: 0 });
  return new Response(stream, {
    headers: {
      'Content-Type': format === 'txt' ? 'text/plain; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
