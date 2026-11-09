/**
 * Calendar-date arithmetic in an organization's time zone — no dependencies, built on `Intl`.
 *
 * Two features read *dates* rather than instants: the Upload Date filter (SRCH-6, inclusive From/To)
 * and auto-delete ("Upload Date + period <= today", RET-3). Both mean the date on the organization's
 * calendar, not UTC's — a file uploaded at 01:00 IST on 1 March was uploaded on 1 March, even though
 * it is still 28 February in UTC. Dates travel as `YYYY-MM-DD` strings so they can't be mistaken for
 * instants.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** A real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30 and friends). */
export function isIsoDate(value: string): value is IsoDate {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function parts(date: IsoDate): [number, number, number] {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function format(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The calendar date an instant falls on in a time zone. */
export function localDate(instant: Date, timeZone: string): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return format(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/**
 * The date auto-delete becomes due: the Upload Date plus a whole number of years (RET-3).
 *
 * Leap-day rule (a deliberate decision, recorded in each_update.md): a document uploaded on 29
 * February is due on **1 March** in a year with no 29 February — never on 28 February. Of the two
 * readings, this is the one that can only ever keep a document a day *longer* than the period, never
 * delete it before the period has fully run. Every other date maps to the same month and day.
 */
export function autoDeleteDueDate(uploadDate: IsoDate, years: number): IsoDate {
  const [y, m, d] = parts(uploadDate);
  const target = y + years;
  if (m === 2 && d === 29 && !isLeapYear(target)) return format(target, 3, 1);
  return format(target, m, d);
}

/**
 * The latest Upload Date that is due on or before `today` for a period — the cut-off the daily run
 * scans for (`uploadDate <= cutoff` ⇔ `dueDate(uploadDate) <= today`, because the due date never goes
 * backwards as the upload date moves forward). Derived from `autoDeleteDueDate` itself rather than
 * re-implemented, so the two can never disagree on a leap day.
 */
export function autoDeleteUploadCutoff(today: IsoDate, years: number): IsoDate {
  const [y, m, d] = parts(today);
  // Start from the same month/day `years` earlier (29 Feb clamps to 28 Feb), then nudge.
  let cutoff = m === 2 && d === 29 && !isLeapYear(y - years) ? format(y - years, 2, 28) : format(y - years, m, d);
  while (autoDeleteDueDate(cutoff, years) > today) cutoff = addDays(cutoff, -1);
  while (autoDeleteDueDate(addDays(cutoff, 1), years) <= today) cutoff = addDays(cutoff, 1);
  return cutoff;
}

/** Offset of a time zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(formatted.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a local wall-clock time occurs on a calendar date in a time zone. */
export function zonedTimeToInstant(date: IsoDate, time: string, timeZone: string): Date {
  const [y, m, d] = parts(date);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset across a DST change (Asia/Kolkata has none; other zones may).
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Start of a calendar date in a time zone (local midnight), as an instant. */
export function startOfLocalDate(date: IsoDate, timeZone: string): Date {
  return zonedTimeToInstant(date, "00:00", timeZone);
}

/** The next time a daily HH:MM schedule fires after `now`, as an instant. */
export function nextDailyRun(now: Date, time: string, timeZone: string): Date {
  const today = localDate(now, timeZone);
  const todayRun = zonedTimeToInstant(today, time, timeZone);
  return todayRun.getTime() > now.getTime() ? todayRun : zonedTimeToInstant(addDays(today, 1), time, timeZone);
}
