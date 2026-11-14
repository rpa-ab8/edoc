// Calendar-date helpers shared by the date pickers. Values are plain `YYYY-MM-DD` strings built and
// compared as local year/month/day — never through a UTC instant — so no time zone can shift a day.

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export function parse(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function shift(value: string, days: number): string {
  const d = parse(value);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

/** The same day in another month, pulled back to that month's last day if it has fewer. */
export function withMonth(value: string, year: number, month: number): string {
  const last = new Date(year, month + 1, 0).getDate();
  return ymd(new Date(year, month, Math.min(Number(value.slice(8)), last)));
}

/** 0 = Sunday … 6 = Saturday, from the browser's locale; Monday where the locale doesn't say. */
function localeWeekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    if (firstDay) return firstDay % 7;
  } catch {
    // An unrecognised locale tag — fall through to Monday.
  }
  return 1;
}

export const WEEK_START = localeWeekStart();
export const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" }));
export const MONTHS_SHORT = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleDateString(undefined, { month: "short" }),
);
// 1 Jan 2023 was a Sunday, so day k of that week is weekday k.
export const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2023, 0, 1 + ((WEEK_START + i) % 7)).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2),
);
