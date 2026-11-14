import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { daysBetween, formatCalendarDate } from "../lib/retention";
import { ArrowRightIcon, CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "./icons";
import { GridChoice, NavButton } from "./CalendarParts";
import { MONTHS, MONTHS_SHORT, WEEKDAYS, WEEK_START, isDate, parse, shift, withMonth, ymd } from "../lib/calendarDates";

/**
 * A date-range field with its own calendar, replacing a pair of native `<input type="date">`s.
 *
 * Same reason as `Select`: the native picker is drawn by the browser, so it arrives with system
 * fonts and system blue, looks different in every browser, and shows one end of the range at a
 * time with no sight of the other. Here both ends live in one field and one calendar, the span
 * between them is drawn, and the common ranges are one click away.
 *
 * Values are what the inputs produced — inclusive `YYYY-MM-DD` strings, "" for an open end — so
 * callers and the server see no change, and either end may still be left open. They are calendar
 * dates: built and compared as local year/month/day, never through a UTC instant, so no time zone
 * can shift a day.
 */

type End = "from" | "to";
type View = "days" | "months" | "years";

const PRESETS: { label: string; range: (today: string) => [string, string] }[] = [
  { label: "Today", range: (t) => [t, t] },
  { label: "Yesterday", range: (t) => [shift(t, -1), shift(t, -1)] },
  { label: "Last 7 days", range: (t) => [shift(t, -6), t] },
  { label: "Last 30 days", range: (t) => [shift(t, -29), t] },
  { label: "This month", range: (t) => [`${t.slice(0, 8)}01`, t] },
  {
    label: "Last month",
    range: (t) => {
      const d = parse(t);
      return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
    },
  },
  { label: "This year", range: (t) => [`${t.slice(0, 4)}-01-01`, t] },
  {
    label: "Last year",
    range: (t) => {
      const y = Number(t.slice(0, 4)) - 1;
      return [`${y}-01-01`, `${y}-12-31`];
    },
  },
];

const display = (value: string) => (isDate(value) ? formatCalendarDate(value) : value);

export function DateRangePicker({
  from,
  to,
  onChange,
  presets = false,
  invalid = false,
  label = "Date range",
  className = "",
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** Show the quick ranges (Today, Last 7 days, …) beside the calendar. */
  presets?: boolean;
  invalid?: boolean;
  label?: string;
  className?: string;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Set when the focused day should take keyboard focus — on open and on arrow-key moves, but not
  // on a month-arrow click, which would pull focus off the button being clicked.
  const focusDay = useRef(false);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<End>("from");
  const [view, setView] = useState<View>("days");
  // The focused day. Its month is the month on show.
  const [cursor, setCursor] = useState(() => ymd(new Date()));
  const [hover, setHover] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const today = ymd(new Date());
  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7)) - 1;

  function openAt(end: End) {
    if (open && editing === end) {
      close();
      return;
    }
    const anchor = (end === "from" ? from || to : to || from) || today;
    setEditing(end);
    setCursor(isDate(anchor) ? anchor : today);
    setView("days");
    setHover(null);
    focusDay.current = true;
    setOpen(true);
  }

  function close(refocus = false) {
    setOpen(false);
    setHover(null);
    if (refocus) (editing === "from" ? fromRef : toRef).current?.focus();
  }

  function pick(day: string) {
    setHover(null);
    setCursor(day);
    if (editing === "from") {
      // A start after the current end makes that end meaningless, so it is cleared.
      onChange(day, to && day > to ? "" : to);
      setEditing("to");
    } else if (from && day < from) {
      // An end before the start restarts the range there, still waiting for its end.
      onChange(day, "");
    } else {
      onChange(from, day);
      close(true);
    }
  }

  function applyPreset(range: [string, string]) {
    onChange(range[0], range[1]);
    setCursor(range[1]);
    close(true);
  }

  // Place the popover under the field — or above it when there isn't room — and keep it on screen.
  useLayoutEffect(() => {
    if (!open || !fieldRef.current || !popRef.current) return;
    const field = fieldRef.current.getBoundingClientRect();
    const pop = popRef.current.getBoundingClientRect();
    const gap = 8;
    const fitsBelow = field.bottom + gap + pop.height <= window.innerHeight - gap;
    const fitsAbove = field.top - gap - pop.height >= gap;
    setPosition({
      top: fitsBelow || !fitsAbove ? field.bottom + gap : field.top - gap - pop.height,
      left: Math.max(gap, Math.min(field.left, window.innerWidth - pop.width - gap)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setHover(null);
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!fieldRef.current?.contains(target) && !popRef.current?.contains(target)) dismiss();
    };
    // A fixed-position portal would drift away from its field on page scroll, so scroll closes it.
    const onScroll = (event: Event) => {
      if (!popRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || view !== "days" || !focusDay.current) return;
    focusDay.current = false;
    popRef.current?.querySelector<HTMLButtonElement>(`[data-day="${cursor}"]`)?.focus({ preventScroll: true });
  }, [open, view, cursor]);

  function onDayKey(event: KeyboardEvent) {
    const column = (parse(cursor).getDay() - WEEK_START + 7) % 7;
    const step = event.shiftKey ? 12 : 1;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => shift(cursor, -1),
      ArrowRight: () => shift(cursor, 1),
      ArrowUp: () => shift(cursor, -7),
      ArrowDown: () => shift(cursor, 7),
      Home: () => shift(cursor, -column),
      End: () => shift(cursor, 6 - column),
      PageUp: () => withMonth(cursor, year, month - step),
      PageDown: () => withMonth(cursor, year, month + step),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    focusDay.current = true;
    setCursor(move());
  }

  function onPopoverKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (view !== "days") setView("days");
    else close(true);
  }

  // The range as drawn: the committed ends, with the end being chosen following the pointer.
  let lo = from;
  let hi = to;
  if (hover) {
    if (editing === "from" && (!to || hover <= to)) lo = hover;
    if (editing === "to" && (!from || hover >= from)) hi = hover;
  }
  const hasSpan = isDate(lo) && isDate(hi) && lo < hi;

  const firstOfMonth = new Date(year, month, 1);
  const lead = (firstOfMonth.getDay() - WEEK_START + 7) % 7;
  const days = Array.from({ length: 42 }, (_, i) => ymd(new Date(year, month, 1 - lead + i)));
  const decade = Math.floor(year / 12) * 12;

  const activePreset = PRESETS.find((p) => {
    const [a, b] = p.range(today);
    return a === from && b === to;
  });

  const summary =
    from && to
      ? `${display(from)} – ${display(to)}`
      : from
        ? `From ${display(from)} onward`
        : to
          ? `Up to ${display(to)}`
          : "Any date";
  const span = isDate(from) && isDate(to) && from <= to ? daysBetween(from, to) + 1 : null;

  const nav = (delta: number) => {
    if (view === "days") setCursor(withMonth(cursor, year, month + delta));
    else if (view === "months") setCursor(withMonth(cursor, year + delta, month));
    else setCursor(withMonth(cursor, year + delta * 12, month));
  };

  const ringClass = invalid
    ? `border-danger ${open ? "ring-[3px] ring-danger/15" : ""}`
    : open
      ? "border-primary ring-[3px] ring-primary/15"
      : "border-line hover:border-[#C9D2CD] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15";

  return (
    <>
      <div
        ref={fieldRef}
        className={`flex items-stretch rounded-lg border bg-surface transition-[border-color,box-shadow] ${ringClass} ${className}`}
      >
        <span className={`flex shrink-0 items-center pl-3.5 pr-1 ${open ? "text-primary" : "text-subtle"}`}>
          <CalendarIcon size={16} />
        </span>
        {(["from", "to"] as const).map((end, index) => {
          const value = end === "from" ? from : to;
          const active = open && editing === end;
          return (
            <div key={end} className="flex min-w-0 flex-1 items-center">
              {index === 1 && <ArrowRightIcon size={14} className="mx-0.5 shrink-0 text-subtle/70" />}
              <button
                ref={end === "from" ? fromRef : toRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={active}
                aria-invalid={invalid || undefined}
                aria-label={`${label}, ${end === "from" ? "start" : "end"}: ${value ? display(value) : "any date"}`}
                onClick={() => openAt(end)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && open) {
                    event.preventDefault();
                    close();
                  }
                }}
                className={`my-1 min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left font-sans text-[15px] leading-6 transition-colors focus:outline-none focus-visible:bg-surface-muted ${
                  active ? "bg-primary-tint text-primary-dark" : value ? "text-ink hover:bg-surface-muted" : "text-subtle hover:bg-surface-muted"
                }`}
              >
                {value ? display(value) : end === "from" ? "Start date" : "End date"}
              </button>
            </div>
          );
        })}
        {from || to ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onChange("", "");
              close();
            }}
            className="my-auto ml-0.5 mr-1.5 shrink-0 rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={14} />
          </button>
        ) : (
          <span className="w-2 shrink-0" />
        )}
      </div>

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={label}
            onKeyDown={onPopoverKey}
            onBlur={(event) => {
              // Tabbing out closes it. A null relatedTarget is a click on the popover's own
              // background, which must not.
              const next = event.relatedTarget as Node | null;
              if (next && !popRef.current?.contains(next) && !fieldRef.current?.contains(next)) close();
            }}
            style={{ position: "fixed", top: position.top, left: position.left }}
            className="z-50 animate-fade-up overflow-hidden rounded-2xl border border-line bg-surface shadow-card-lg"
          >
            {presets && (
              <div className="flex gap-1.5 overflow-x-auto border-b border-line-muted px-3 py-2.5 sm:hidden">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p.range(today))}
                    className={`shrink-0 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${
                      activePreset === p
                        ? "border-primary bg-primary-tint text-primary"
                        : "border-line text-muted hover:border-primary/40"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="flex">
              {presets && (
                <div className="hidden w-[164px] shrink-0 flex-col gap-0.5 border-r border-line-muted bg-canvas/60 p-2 sm:flex">
                  <p className="px-3 pb-1.5 pt-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-subtle">
                    Quick ranges
                  </p>
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => applyPreset(p.range(today))}
                      className={`rounded-lg px-3 py-2 text-left text-[14px] transition-colors ${
                        activePreset === p
                          ? "bg-primary-tint font-semibold text-primary"
                          : "text-muted hover:bg-surface hover:text-ink"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="w-[312px] px-4 pb-3 pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setView(view === "days" ? "months" : view === "months" ? "years" : "days")}
                    aria-label={view === "years" ? "Back to days" : "Choose month and year"}
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] font-semibold tracking-[-0.2px] text-ink transition-colors hover:bg-surface-muted"
                  >
                    {view === "days" ? `${MONTHS[month]} ${year}` : view === "months" ? year : `${decade} – ${decade + 11}`}
                    <ChevronDownIcon
                      size={14}
                      className={`text-subtle transition-transform ${view === "days" ? "" : "rotate-180"}`}
                    />
                  </button>
                  <div className="flex items-center gap-1">
                    <NavButton label={view === "days" ? "Previous month" : view === "months" ? "Previous year" : "Earlier years"} onClick={() => nav(-1)}>
                      <ChevronLeftIcon size={16} />
                    </NavButton>
                    <NavButton label={view === "days" ? "Next month" : view === "months" ? "Next year" : "Later years"} onClick={() => nav(1)}>
                      <ChevronRightIcon size={16} />
                    </NavButton>
                  </div>
                </div>

                {view === "days" && (
                  <>
                    <div className="grid grid-cols-7">
                      {WEEKDAYS.map((d, i) => (
                        <span key={i} className="flex h-8 items-center justify-center text-[12px] font-medium text-subtle">
                          {d}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7" onMouseLeave={() => setHover(null)}>
                      {days.map((day, i) => {
                        const column = i % 7;
                        const inMonth = Number(day.slice(5, 7)) - 1 === month;
                        const isEnd = day === lo || day === hi;
                        const committed = day === from || day === to;
                        const inside = hasSpan && day > lo && day < hi;
                        const band = hasSpan && (inside || isEnd);
                        return (
                          <div key={day} className="relative flex h-10 items-center justify-center">
                            {band && (
                              <span
                                aria-hidden
                                className={`absolute inset-y-[2px] bg-primary-tint ${inMonth ? "" : "opacity-60"} ${
                                  day === lo ? "left-1/2" : "left-0"
                                } ${day === hi ? "right-1/2" : "right-0"} ${
                                  column === 0 && day !== lo ? "rounded-l-full" : ""
                                } ${column === 6 && day !== hi ? "rounded-r-full" : ""}`}
                              />
                            )}
                            <button
                              type="button"
                              data-day={day}
                              tabIndex={day === cursor ? 0 : -1}
                              aria-label={parse(day).toLocaleDateString(undefined, {
                                weekday: "long",
                                day: "numeric",
                                month: "long",
                                year: "numeric",
                              })}
                              aria-pressed={committed}
                              aria-current={day === today ? "date" : undefined}
                              onClick={() => pick(day)}
                              onMouseEnter={() => setHover(day)}
                              onKeyDown={onDayKey}
                              className={`relative flex h-9 w-9 items-center justify-center rounded-full text-[14px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
                                committed
                                  ? "bg-primary font-semibold text-white shadow-action hover:bg-primary-dark"
                                  : isEnd
                                    ? "bg-surface font-semibold text-primary ring-[1.5px] ring-inset ring-primary"
                                    : inside
                                      ? `font-medium hover:bg-primary/10 ${inMonth ? "text-primary-dark" : "text-primary-dark/50"}`
                                      : `hover:bg-surface-muted ${inMonth ? "text-ink" : "text-subtle/50"}`
                              } ${day === today && !committed ? "font-semibold" : ""}`}
                            >
                              {Number(day.slice(8))}
                              {day === today && (
                                <span
                                  aria-hidden
                                  className={`absolute bottom-[5px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                                    committed ? "bg-white" : "bg-primary"
                                  }`}
                                />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {view === "months" && (
                  <div className="grid h-[272px] grid-cols-3 content-center gap-2">
                    {MONTHS_SHORT.map((name, m) => (
                      <GridChoice
                        key={name}
                        selected={m === month}
                        current={year === Number(today.slice(0, 4)) && m === Number(today.slice(5, 7)) - 1}
                        onClick={() => {
                          setCursor(withMonth(cursor, year, m));
                          setView("days");
                        }}
                      >
                        {name}
                      </GridChoice>
                    ))}
                  </div>
                )}

                {view === "years" && (
                  <div className="grid h-[272px] grid-cols-3 content-center gap-2">
                    {Array.from({ length: 12 }, (_, i) => decade + i).map((y) => (
                      <GridChoice
                        key={y}
                        selected={y === year}
                        current={y === Number(today.slice(0, 4))}
                        onClick={() => {
                          setCursor(withMonth(cursor, y, month));
                          setView("months");
                        }}
                      >
                        {y}
                      </GridChoice>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-muted bg-canvas/60 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">
                  {summary}
                  {span !== null && (
                    <span className="ml-1.5 font-normal text-subtle">
                      · {span} day{span === 1 ? "" : "s"}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[12.5px] text-subtle">
                  {editing === "from" ? "Select the start date" : "Select the end date, or leave it open"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={!from && !to}
                  onClick={() => {
                    onChange("", "");
                    setEditing("from");
                  }}
                  className="rounded-lg px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => close(true)}
                  className="rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-white shadow-action transition-colors hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
