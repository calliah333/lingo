import type { Attention } from './chat';

const iconUrl = '/favicon.svg';
const size = 64;
const dotColor = { mention: '#e5484d', unread: '#8b949e' } as const;

let icon: Promise<HTMLImageElement> | null = null;
let serial = 0;

function loadIcon(): Promise<HTMLImageElement> {
  if (!icon) {
    const image = new Image();
    image.src = iconUrl;
    icon = image.decode().then(() => image, (error: unknown) => {
      icon = null;
      throw error;
    });
  }
  return icon;
}

function setIcon(href: string, type: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  if (link.getAttribute('href') === href) return;
  link.type = type;
  link.href = href;
}

/** Puts `(N) Lingo` / `• Lingo` in the tab title and a red (mentions) or grey (unread) dot on the favicon. */
export function showAttention({ mentions, unread }: Attention) {
  document.title = mentions ? `(${mentions}) Lingo` : unread ? '• Lingo' : 'Lingo';
  const current = ++serial;
  const kind = mentions ? 'mention' : unread ? 'unread' : null;
  if (!kind) {
    setIcon(iconUrl, 'image/svg+xml');
    return;
  }
  loadIcon().then((image) => {
    if (current !== serial) return;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, size, size);
    context.beginPath();
    context.arc(49, 15, 13, 0, Math.PI * 2);
    context.fillStyle = dotColor[kind];
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = '#0c1218';
    context.stroke();
    setIcon(canvas.toDataURL('image/png'), 'image/png');
  }, () => {
    // Without the base icon, the title still carries the state.
  });
}
