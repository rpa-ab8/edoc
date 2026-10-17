import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional second line — used for field-type hints and role descriptions. */
  hint?: string;
  disabled?: boolean;
}

/**
 * A styled listbox, replacing the native `<select>`.
 *
 * Native selects can't be styled beyond their box: the popup is drawn by the operating system, so
 * it arrives with system fonts, system spacing and system blue highlights, and looks like it
 * belongs to a different product. That mismatch was the "cheap dropdown" problem — everywhere the
 * interface had a choice to offer, it borrowed someone else's design.
 *
 * The menu renders through a portal because these sit inside tables and cards with
 * `overflow-hidden`, which would otherwise clip it.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  className = "",
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; above: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    above: false,
  });

  const selected = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimated = Math.min(options.length * 44 + 12, 288);
    // Flip above when there isn't room below — a menu that opens off-screen is unusable.
    const above = rect.bottom + estimated > window.innerHeight && rect.top > estimated;
    setPosition({
      top: above ? rect.top - estimated - 6 : rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      above,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (
        !triggerRef.current?.contains(event.target as Node) &&
        !listRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onResize = () => setOpen(false);
    // Page scroll closes the menu — it's a fixed-position portal that would otherwise drift away
    // from its trigger. But scrolling *inside* the menu (a long option list, e.g. the field-type
    // picker whose options each carry a hint line) must keep it open, so scroll events that
    // originate within the listbox are ignored rather than closing it.
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (disabled) return;
    if (!open && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(active);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key.length === 1) {
      // Type-ahead, the one native-select behaviour worth keeping.
      const match = options.findIndex((o) => o.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (match >= 0) setActive(match);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-listbox` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`flex items-center justify-between gap-2 rounded-lg border bg-surface px-3.5 py-2.5 text-left font-sans text-[15px] leading-6 transition-[border-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "border-primary ring-[3px] ring-primary/15" : "border-line hover:border-[#C9D2CD]"
        } focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 ${className}`}
      >
        <span className={`min-w-0 truncate ${selected ? "text-ink" : "text-subtle"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDownIcon
          size={15}
          className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={`${id}-listbox`}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              minWidth: Math.max(position.width, 200),
              maxHeight: 288,
            }}
            className="z-50 animate-fade-up overflow-y-auto rounded-xl border border-line bg-surface py-1.5 shadow-card-lg"
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <li key={option.value} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    disabled={option.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(index)}
                    className={`flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      index === active ? "bg-surface-muted" : ""
                    } ${isSelected ? "text-primary" : "text-ink"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[14.5px] ${isSelected ? "font-semibold" : ""}`}>
                        {option.label}
                      </span>
                      {option.hint && (
                        <span className="mt-0.5 block truncate text-[12.5px] text-subtle">{option.hint}</span>
                      )}
                    </span>
                    {isSelected && <CheckIcon size={16} className="mt-0.5 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
