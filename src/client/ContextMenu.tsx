import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export type MenuItem = {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** The first row names the target; it may still be actionable (for example, opening it). */
  heading?: boolean;
  danger?: boolean;
};

type ContextMenuProps = {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: () => void;
};

export default function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.focus();
  }

  return <div ref={menuRef} className="context-menu" role="menu" aria-label={label}
    style={position} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item) => item.heading && !item.onSelect
      ? <div key={item.label} className="context-menu__heading" role="presentation">{item.label}</div>
      : <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
        className={`${item.heading ? 'context-menu__heading' : ''}${item.danger ? ' context-menu__danger' : ''}`}
        onClick={() => {
          onClose();
          item.onSelect?.();
        }}>{item.label}</button>)}
  </div>;
}
