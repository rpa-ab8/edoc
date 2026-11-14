import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatCalendarDate } from "../lib/retention";
import { MONTHS, MONTHS_SHORT, WEEKDAYS, WEEK_START, isDate, parse, shift, withMonth, ymd } from "../lib/calendarDates";
import { GridChoice, NavButton } from "./CalendarParts";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "./icons";

type View = "days" | "months" | "years";

/**
 * A single-date field with its own calendar, for document fields of type "date".
 *
 * Same reason as `DateRangePicker` and `Select`: the browser's native date control is drawn by the
 * browser, so it arrives with system fonts and system blue, looks different in every browser, and
 * has nothing to do with the rest of the interface. This one shares the range picker's calendar —
 * month / year pickers, keyboard movement, locale week start — and adds "Today".
 *
 * The value is what `<input type="date">` produced: a `YYYY-MM-DD` string, "" for no date, so what
 * is saved and what the search index sees are unchanged.
 */
export function DatePicker({
  value,
  onChange,
  label = "Date",
  placeholder = "Select a date",
  invalid = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Set when the focused day should take keyboard focus — on open and on arrow-key moves, but not
  // on a month-arrow click, which would pull focus off the button being clicked.
  const focusDay = useRef(false);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("days");
  // The focused day. Its month is the month on show.
  const [cursor, setCursor] = useState(() => ymd(new Date()));
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const today = ymd(new Date());
  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7)) - 1;
  const selected = isDate(value) ? value : "";

  function openPicker() {
    if (open) {
      close();
      return;
    }
    setCursor(selected || today);
    setView("days");
    focusDay.current = true;
    setOpen(true);
  }

  function close(refocus = false) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function pick(day: string) {
    onChange(day);
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
    const dismiss = () => setOpen(false);
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

  const firstOfMonth = new Date(year, month, 1);
  const lead = (firstOfMonth.getDay() - WEEK_START + 7) % 7;
  const days = Array.from({ length: 42 }, (_, i) => ymd(new Date(year, month, 1 - lead + i)));
  const decade = Math.floor(year / 12) * 12;

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
        className={`flex items-stretch rounded-lg border bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] ${ringClass} ${className}`}
      >
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-label={`${label}: ${selected ? formatCalendarDate(selected) : "no date chosen"}`}
          onClick={openPicker}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left font-sans text-[15px] leading-6 focus:outline-none"
        >
          <span className={`shrink-0 ${open ? "text-primary" : "text-subtle"}`}>
            <CalendarIcon size={16} />
          </span>
          <span className={`truncate ${selected ? "text-ink" : "text-subtle"}`}>
            {selected ? formatCalendarDate(selected) : placeholder}
          </span>
        </button>
        {selected && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onChange("");
              close();
            }}
            className="my-auto mr-1.5 shrink-0 rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={14} />
          </button>
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
            className="z-50 w-[312px] animate-fade-up overflow-hidden rounded-2xl border border-line bg-surface shadow-card-lg"
          >
            <div className="px-4 pb-3 pt-4">
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
                  <div className="grid grid-cols-7">
                    {days.map((day) => {
                      const inMonth = Number(day.slice(5, 7)) - 1 === month;
                      const chosen = day === selected;
                      return (
                        <div key={day} className="flex h-10 items-center justify-center">
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
                            aria-pressed={chosen}
                            aria-current={day === today ? "date" : undefined}
                            onClick={() => pick(day)}
                            onKeyDown={onDayKey}
                            className={`relative flex h-9 w-9 items-center justify-center rounded-full text-[14px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
                              chosen
                                ? "bg-primary font-semibold text-white shadow-action hover:bg-primary-dark"
                                : `hover:bg-surface-muted ${inMonth ? "text-ink" : "text-subtle/50"} ${
                                    day === today ? "font-semibold" : ""
                                  }`
                            }`}
                          >
                            {Number(day.slice(8))}
                            {day === today && (
                              <span
                                aria-hidden
                                className={`absolute bottom-[5px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                                  chosen ? "bg-white" : "bg-primary"
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

            <div className="flex items-center justify-between border-t border-line-muted bg-canvas/60 px-4 py-2.5">
              <button
                type="button"
                onClick={() => pick(today)}
                className="rounded-lg px-3 py-2 text-[14px] font-medium text-primary transition-colors hover:bg-primary-tint"
              >
                Today
              </button>
              <button
                type="button"
                disabled={!selected}
                onClick={() => {
                  onChange("");
                  close(true);
                }}
                className="rounded-lg px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Clear
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
