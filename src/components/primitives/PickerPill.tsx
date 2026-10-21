import { useEffect, useId, useRef, useState } from 'react';

export type PickerOption = { value: string; label: string };

/** The manual-compact affordance, in the same pill language as the model
 *  pickers so it reads as part of the composer's furniture. */
export function CompactPill({
  onClick,
  disabled = false,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? 'summarize this chat so far and make room; the thread stays'}
      className="sw-picker-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--pill-bg)',
        color: 'var(--pill-ink)',
        border: '1px solid var(--pill-border)',
        borderRadius: 999,
        padding: '3px 11px',
        fontFamily: 'var(--serif-display)',
        fontStyle: 'italic',
        fontSize: 13.5,
        lineHeight: 1.5,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ opacity: 0.75 }}>
        <path
          d="M1.5 4.5V1.5h3M10.5 7.5v3h-3M4.9 7.1 2.1 9.9M7.1 4.9l2.8-2.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      compact
    </button>
  );
}

/**
 * A small pill dropdown with the app's toy feel: the pill lifts and glows
 * under the cursor, presses in on click, and the menu springs open below it.
 * Keyboard: Enter/Space opens, arrows move, Enter picks, Escape closes.
 * Clicking anywhere else closes it.
 */
export function PickerPill({
  ariaLabel,
  title,
  value,
  options,
  onChange,
  disabled = false,
  align = 'left',
  drop = 'down',
}: {
  ariaLabel: string;
  title?: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  align?: 'left' | 'right';
  /** Which way the menu opens. The mobile composer sits at the bottom of the
   *  screen, so it opens upward instead of off the edge. */
  drop?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const optionIdBase = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // pointerdown reaches iOS taps on non-clickable areas; mousedown does not.
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (next: string) => {
    if (disabled) return;
    setOpen(false);
    setActive(-1);
    if (next !== value) onChange(next);
  };

  const openMenu = () => {
    if (disabled) return;
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx < 0 ? 0 : idx);
    setOpen(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + delta + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const pick = options[active];
      if (pick) choose(pick.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${optionIdBase}-list` : undefined}
        // Focus stays on the button, so the active option has to be pointed
        // at explicitly for screen readers.
        aria-activedescendant={open && active >= 0 ? `${optionIdBase}-opt-${active}` : undefined}
        title={title}
        disabled={disabled}
        onClick={(e) => {
          // Enter/Space already open the menu on keydown; the click these
          // keys synthesize afterwards would immediately toggle it shut.
          if (e.detail === 0) return;
          if (open) setOpen(false); else openMenu();
        }}
        onKeyDown={onKeyDown}
        className="sw-picker-pill"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: open ? 'rgba(184,89,58,0.10)' : 'var(--pill-bg)',
          color: open ? 'var(--ink)' : 'var(--pill-ink)',
          border: `1px solid ${open ? 'rgba(184,89,58,0.55)' : 'var(--pill-border)'}`,
          borderRadius: 999,
          padding: '3px 10px 3px 12px',
          fontFamily: 'var(--serif-display)',
          fontStyle: 'italic',
          fontSize: 13.5,
          lineHeight: 1.5,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          userSelect: 'none',
        }}
      >
        <span>{current?.label ?? value}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
          style={{
            transition: 'transform 180ms cubic-bezier(.34,1.56,.64,1)',
            transform: open ? 'rotate(180deg)' : 'none',
            opacity: 0.7,
          }}
        >
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          id={`${optionIdBase}-list`}
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={drop === 'up' ? 'sw-picker-pop sw-picker-pop-up' : 'sw-picker-pop'}
          style={{
            position: 'absolute',
            ...(drop === 'up' ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
            minWidth: '100%',
            whiteSpace: 'nowrap',
            background: 'var(--vellum)',
            border: '1px solid var(--rule)',
            borderRadius: 14,
            boxShadow: '0 10px 30px rgba(74,50,24,0.18), 0 1px 0 rgba(255,255,255,0.4) inset',
            padding: 5,
            zIndex: 60,
          }}
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                id={`${optionIdBase}-opt-${i}`}
                role="option"
                aria-selected={selected}
                className="sw-picker-opt"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(opt.value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 10px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  fontFamily: 'var(--serif-display)',
                  fontStyle: 'italic',
                  fontSize: 14,
                  color: 'var(--ink)',
                  background: i === active ? 'rgba(184,89,58,0.10)' : 'transparent',
                }}
              >
                <span>{opt.label}</span>
                {selected && (
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                    <path d="M2.5 6.3 5 8.6 9.5 3.7" fill="none" stroke="rgba(184,89,58,0.9)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
