import { useEffect, useRef, type ReactNode } from 'react';

export type IconName = 'spark' | 'plus' | 'chat' | 'settings' | 'arrow' | 'stop' | 'shield' | 'close' | 'trash' | 'search' | 'refresh' | 'chevron' | 'terminal'
  | 'bot' | 'clock' | 'key' | 'bell' | 'device' | 'edit' | 'play' | 'copy' | 'check' | 'brain' | 'collapse' | 'expand' | 'folder' | 'palette' | 'download' | 'login';
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    spark: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /><path d="m20 2 .7 2.3L23 5l-2.3.7L20 8l-.7-2.3L17 5l2.3-.7Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z" />,
    settings: <><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z" /><circle cx="11.5" cy="11" r="3" /></>,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 3v8h-8" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    bot: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4m-3 8v2m6-2v2" /><circle cx="12" cy="3.5" r="1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-3 3 3 3" /></>,
    bell: <><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4Z" /><path d="M10 21h4" /></>,
    device: <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    edit: <path d="m4 20 1-4L16 5l3 3L8 19Zm9-13 3 3" />,
    play: <path d="m7 5 12 7-12 7Z" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    check: <path d="m5 12 5 5 9-10" />,
    collapse: <path d="m6 6 6 6-6 6m7-12 6 6-6 6" />,
    expand: <path d="m18 6-6 6 6 6m-7-12-6 6 6 6" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    palette: <><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 2-1 3-1a4 4 0 0 0 4-4c0-4.5-4-8-9-8Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
    download: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
    login: <><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /><path d="M14 8l4 4-4 4M18 12H9" /></>,
    brain: <><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 5 3 3 0 0 0 5 2V4a3 3 0 0 0-3 0Z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 5 3 3 0 0 1-5 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); }
      if (event.key === 'Tab' && dialog) {
        const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="modal-heading"><h2>{title}</h2>{onClose && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button>}</div>{children}</div></div>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function PageHeader({ title, caption, actions }: { title: string; caption?: string; actions?: ReactNode }) {
  return <div className="page-header"><div><h2>{title}</h2>{caption && <p>{caption}</p>}</div><div className="page-actions">{actions}</div></div>;
}
