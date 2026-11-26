import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "./icons";
import type { SelectOption } from "./Select";

/**
 * Searchable pickers — the long-list companions to `Select`.
 *
 * `Select` is right for a handful of choices, but some lists run to hundreds of entries (everyone in
 * the organization, a department's 200-option dropdown field). Scrolling a plain menu for one name
 * is the "I can't find the employee" problem; these put a search box at the top of the menu and
 * match on both the label and the hint line (so a person can be found by name or by email).
 *
 * - `SearchSelect` picks one value.
 * - `MultiSearchSelect` ticks several; the menu stays open while ticking, and the choices show as
 *   removable chips under the trigger so the selection is visible without reopening it.
 *
 * Both render their menu through a portal, like `Select`, so cards and tables with
 * `overflow-hidden` don't clip it.
 */

const PANEL_MAX_LIST = 264;
const SEARCH_HEIGHT = 54;

/** Every typed word must appear somewhere in the label or hint, in any order — so "kochi 01" finds
 *  "Branch 001 — Kochi" and "ahmed gmail" finds Ahmed by his email. */
function matches(option: SelectOption, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${option.label} ${option.hint ?? ""}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** Positioning, outside-click and scroll handling shared by both pickers. */
function usePopover(open: boolean, setOpen: (v: boolean) => void, estimatedHeight: number) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Flip above when there isn't room below — a menu that opens off-screen is unusable.
    const above = rect.bottom + estimatedHeight + 8 > window.innerHeight && rect.top > estimatedHeight + 8;
    setPosition({
      top: above ? rect.top - estimatedHeight - 6 : rect.bottom + 6,
      left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 280) - 8),
      width: rect.width,
    });
    // Recomputed only on open: the height estimate changes as the user types, and a menu that jumps
    // while you type into it is worse than one with a little empty space below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    // Page scroll closes the fixed-position menu (it would drift from its trigger); scrolling the
    // option list inside it does not.
    const onScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
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
  }, [open, setOpen]);

  return { triggerRef, panelRef, position };
}

function triggerClass(open: boolean, className: string) {
  return `flex items-center justify-between gap-2 rounded-lg border bg-surface px-3.5 py-2.5 text-left font-sans text-[15px] leading-6 transition-[border-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 ${
    open ? "border-primary ring-[3px] ring-primary/15" : "border-line hover:border-[#C9D2CD]"
  } focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 ${className}`;
}

function SearchPanel({
  id,
  panelRef,
  position,
  query,
  onQuery,
  searchPlaceholder,
  ariaLabel,
  onKeyDown,
  footer,
  children,
  multiselectable,
}: {
  id: string;
  panelRef: React.RefObject<HTMLDivElement | null>;
  position: { top: number; left: number; width: number };
  query: string;
  onQuery: (q: string) => void;
  searchPlaceholder: string;
  ariaLabel?: string;
  onKeyDown: (e: React.KeyboardEvent) => void;
  footer?: ReactNode;
  children: ReactNode;
  multiselectable?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      style={{ position: "fixed", top: position.top, left: position.left, width: Math.max(position.width, 280) }}
      className="z-50 animate-fade-up overflow-hidden rounded-xl border border-line bg-surface shadow-card-lg"
    >
      <div className="flex items-center gap-2 border-b border-line-muted px-3.5 py-2.5">
        <SearchIcon size={15} className="shrink-0 text-subtle" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={searchPlaceholder}
          aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search"}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          role="combobox"
          aria-expanded
          className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-ink placeholder:text-subtle focus:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onQuery("");
              inputRef.current?.focus();
            }}
            className="rounded p-0.5 text-subtle hover:text-ink"
          >
            <XIcon size={13} />
          </button>
        )}
      </div>
      <ul
        id={`${id}-listbox`}
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable={multiselectable || undefined}
        style={{ maxHeight: PANEL_MAX_LIST }}
        className="overflow-y-auto py-1.5"
      >
        {children}
      </ul>
      {footer}
    </div>,
    document.body,
  );
}

function NoMatches({ query }: { query: string }) {
  return (
    <li className="px-3.5 py-6 text-center text-[13.5px] text-subtle">
      {query ? (
        <>
          No match for <span className="font-medium text-ink">“{query}”</span>
        </>
      ) : (
        "Nothing to choose from."
      )}
    </li>
  );
}

/** Keeps the keyboard-highlighted row visible as the arrows move through a long list. */
function useScrollActiveIntoView(panelRef: React.RefObject<HTMLDivElement | null>, id: string, active: number) {
  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-opt-${active}`)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [panelRef, id, active]);
}

function listKeys(
  event: React.KeyboardEvent,
  count: number,
  setActive: (fn: (i: number) => number) => void,
  onEnter: () => void,
  onEscape: () => void,
) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActive((i) => Math.min(count - 1, i + 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActive((i) => Math.max(0, i - 1));
  } else if (event.key === "Enter") {
    event.preventDefault();
    onEnter();
  } else if (event.key === "Escape") {
    event.preventDefault();
    onEscape();
  }
}

// ── Single choice ─────────────────────────────────────────────────────────────

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Type to search…",
  disabled,
  className = "",
  ariaLabel,
  clearable = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Adds a "Clear selection" action to the menu, for optional fields. */
  clearable?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const visible = useMemo(() => options.filter((o) => matches(o, query.trim())), [options, query]);
  const estimated = SEARCH_HEIGHT + Math.min(Math.max(options.length, 1) * 52 + 12, PANEL_MAX_LIST) + (clearable ? 44 : 0);
  const { triggerRef, panelRef, position } = usePopover(open, setOpen, estimated);
  const selected = options.find((o) => o.value === value);
  useScrollActiveIntoView(panelRef, id, active);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function commit(option: SelectOption | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClass(open, className)}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <span className="text-ink">
              {selected.label}
              {selected.hint && <span className="ml-2 text-[13px] text-subtle">{selected.hint}</span>}
            </span>
          ) : (
            <span className="text-subtle">{placeholder}</span>
          )}
        </span>
        <ChevronDownIcon size={15} className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <SearchPanel
          id={id}
          panelRef={panelRef}
          position={position}
          query={query}
          onQuery={(q) => {
            setQuery(q);
            setActive(0);
          }}
          searchPlaceholder={searchPlaceholder}
          ariaLabel={ariaLabel}
          footer={
            clearable && value ? (
              <div className="border-t border-line-muted px-1.5 py-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
                >
                  Clear selection
                </button>
              </div>
            ) : undefined
          }
          onKeyDown={(e) =>
            listKeys(
              e,
              visible.length,
              setActive,
              () => commit(visible[active]),
              () => {
                setOpen(false);
                triggerRef.current?.focus();
              },
            )
          }
        >
          {visible.length === 0 ? (
            <NoMatches query={query.trim()} />
          ) : (
            visible.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <li key={option.value} id={`${id}-opt-${index}`} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={option.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(option)}
                    className={`flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      index === active ? "bg-surface-muted" : ""
                    } ${isSelected ? "text-primary" : "text-ink"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[14.5px] ${isSelected ? "font-semibold" : ""}`}>
                        {option.label}
                      </span>
                      {option.hint && <span className="mt-0.5 block truncate text-[12.5px] text-subtle">{option.hint}</span>}
                    </span>
                    {isSelected && <CheckIcon size={16} className="mt-0.5 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })
          )}
        </SearchPanel>
      )}
    </>
  );
}

// ── Several choices ───────────────────────────────────────────────────────────

export function MultiSearchSelect({
  values,
  options,
  onChange,
  placeholder = "Any",
  searchPlaceholder = "Type to search…",
  disabled,
  className = "",
  ariaLabel,
}: {
  values: string[];
  options: SelectOption[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const id = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const visible = useMemo(() => options.filter((o) => matches(o, query.trim())), [options, query]);
  const estimated = SEARCH_HEIGHT + Math.min(Math.max(options.length, 1) * 42 + 12, PANEL_MAX_LIST) + 44;
  const { triggerRef, panelRef, position } = usePopover(open, setOpen, estimated);
  const selectedSet = useMemo(() => new Set(values), [values]);
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  useScrollActiveIntoView(panelRef, id, active);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  function toggle(option: SelectOption | undefined) {
    if (!option || option.disabled) return;
    onChange(selectedSet.has(option.value) ? values.filter((v) => v !== option.value) : [...values, option.value]);
  }

  const summary =
    values.length === 0
      ? null
      : values.length === 1
        ? labelFor(values[0]!)
        : `${values.length} selected`;

  return (
    <div className="min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClass(open, className)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <SearchIcon size={15} className="shrink-0 text-subtle" />
          <span className={`min-w-0 truncate ${summary ? "text-ink" : "text-subtle"}`}>
            {summary ?? placeholder}
          </span>
        </span>
        <ChevronDownIcon size={15} className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary-tint py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-primary"
            >
              <span className="truncate">{labelFor(v)}</span>
              <button
                type="button"
                aria-label={`Remove ${labelFor(v)}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="rounded-full p-0.5 transition-colors hover:bg-primary/15"
              >
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <SearchPanel
          id={id}
          panelRef={panelRef}
          position={position}
          query={query}
          onQuery={(q) => {
            setQuery(q);
            setActive(0);
          }}
          searchPlaceholder={searchPlaceholder}
          ariaLabel={ariaLabel}
          multiselectable
          onKeyDown={(e) =>
            listKeys(
              e,
              visible.length,
              setActive,
              () => toggle(visible[active]),
              () => {
                setOpen(false);
                triggerRef.current?.focus();
              },
            )
          }
          footer={
            <div className="flex items-center justify-between border-t border-line-muted bg-surface-muted/60 px-3.5 py-2.5">
              <span className="text-[12.5px] text-subtle">
                {values.length === 0 ? `${options.length} options` : `${values.length} of ${options.length} selected`}
              </span>
              <span className="flex items-center gap-3">
                {values.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="text-[12.5px] font-medium text-subtle hover:text-ink"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-dark"
                >
                  Done
                </button>
              </span>
            </div>
          }
        >
          {visible.length === 0 ? (
            <NoMatches query={query.trim()} />
          ) : (
            visible.map((option, index) => {
              const isSelected = selectedSet.has(option.value);
              return (
                <li key={option.value} id={`${id}-opt-${index}`} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={option.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => toggle(option)}
                    className={`flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      index === active ? "bg-surface-muted" : ""
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                        isSelected ? "border-primary bg-primary text-white" : "border-line bg-surface"
                      }`}
                    >
                      {isSelected && <CheckIcon size={12} />}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[14px] ${isSelected ? "font-medium text-ink" : "text-ink"}`}>
                      {option.label}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </SearchPanel>
      )}
    </div>
  );
}
