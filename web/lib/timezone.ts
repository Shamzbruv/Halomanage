// Halomanage — organization-timezone-aware date/time formatting.
//
// Every timestamp this app stores is UTC (Postgres timestamptz). A Server
// Component renders on Railway's own clock (UTC) — nothing like a
// browser's local Date, which reflects the *visitor's* timezone. Every
// `new Date().toLocaleTimeString()` / `new Date().toISOString().slice(0,10)`
// on the server was silently using UTC, not the organization's actual
// timezone. Jamaica (America/Jamaica, UTC-5, no DST) is exactly 5 hours
// behind UTC — precisely the "5 hours ahead" a Jamaica-based customer
// reported on the dashboard's "Current local time." Fixed by always
// resolving and passing an explicit IANA timeZone from the organization's
// own `timezone` column (see session.ts) instead of relying on whatever
// clock the process happens to run on.
//
// Jamaica is also this project's actual customer base today, so it's the
// system default (organizations.timezone's column default, and every RPC
// that creates one) — never a hardcoded assumption inside this file
// itself, which always takes a real timezone and only falls back here if
// one somehow isn't set.

export const DEFAULT_TIMEZONE = "America/Jamaica";

export function orgTimezone(timezone: string | null | undefined): string {
  return timezone && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
}

export function formatTime(value: string | Date, timezone: string | null | undefined): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: orgTimezone(timezone) });
}

export function formatDate(value: string | Date, timezone: string | null | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(value).toLocaleDateString("en", { ...options, timeZone: orgTimezone(timezone) });
}

export function formatDateTime(value: string | Date, timezone: string | null | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(value).toLocaleString("en", { ...options, timeZone: orgTimezone(timezone) });
}

// Current hour-of-day (0-23) in the organization's timezone — for the
// dashboard greeting, which otherwise used the server's own UTC hour
// (e.g. showing "Good evening" during a Jamaican morning).
export function currentHourIn(timezone: string | null | undefined): number {
  const hourString = new Intl.DateTimeFormat("en-US", { timeZone: orgTimezone(timezone), hour: "numeric", hourCycle: "h23" }).format(new Date());
  return Number(hourString);
}

// "Now," as a wall-clock time in the organization's timezone — for
// "Current local time" widgets specifically (distinct from formatTime,
// which converts an already-stored timestamp).
export function currentTimeIn(timezone: string | null | undefined): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: orgTimezone(timezone) });
}

export function currentDateLabelIn(timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: orgTimezone(timezone) }).format(new Date());
}

// Today's calendar date (YYYY-MM-DD) *in the organization's timezone* —
// for query boundaries and date-input defaults. `new Date().toISOString()`
// is always UTC, so for roughly 5 hours every Jamaican evening it names
// tomorrow instead of today; en-CA locale formatting reliably yields
// YYYY-MM-DD without the ISO string's UTC assumption.
export function todayIn(timezone: string | null | undefined): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: orgTimezone(timezone) });
}

// The calendar date (YYYY-MM-DD) a stored timestamp falls on *in the
// organization's timezone*. `String(timestamp).slice(0, 10)` reads the UTC
// date instead — for a Jamaica org, anything after 7pm lands on tomorrow.
export function dateIn(value: string | Date, timezone: string | null | undefined): string {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: orgTimezone(timezone) });
}

// Calendar arithmetic on a YYYY-MM-DD string (no timezone involved: the
// date is already a local calendar date, so it's shifted as a UTC date).
export function addDaysToDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// How far `timeZone`'s wall clock reads ahead of UTC at `instant`, in
// milliseconds (negative for zones behind UTC, e.g. Jamaica). Reads the
// instant's wall-clock parts in that zone via Intl, then re-interprets
// them as UTC — the difference from the real instant is the offset.
function utcOffsetMsAt(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - instant.getTime();
}

// Midnight on the 1st of the current calendar month *in the organization's
// timezone*, returned as the equivalent UTC instant — for query boundaries
// like "points given this month." Using the server's own UTC month instead
// would flip over up to 5 hours early every month for a Jamaica-based org
// (the last evening of the month in Jamaica is already next month in UTC).
export function startOfMonthIn(timezone: string | null | undefined): string {
  const tz = orgTimezone(timezone);
  const [year, month] = todayIn(tz).split("-");
  const guess = new Date(Date.UTC(Number(year), Number(month) - 1, 1, 0, 0, 0));
  const offsetMs = utcOffsetMsAt(guess, tz);
  return new Date(guess.getTime() - offsetMs).toISOString();
}

// A wall-clock "YYYY-MM-DDTHH:mm" (as a datetime-local input gives it),
// read as a time in the organization's timezone, converted to a UTC ISO
// string. Used so an attendance correction means the same thing whatever
// timezone the person's device is set to.
export function zonedInputToUtc(local: string, timezone: string | null | undefined): string {
  const tz = orgTimezone(timezone);
  const [datePart, timePart] = local.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = (timePart ?? "00:00").split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = utcOffsetMsAt(guess, tz);
  const first = new Date(guess.getTime() - offset);
  // Re-check the offset at the resulting instant (DST transitions).
  const corrected = utcOffsetMsAt(first, tz);
  return new Date(guess.getTime() - corrected).toISOString();
}

// The reverse: a stored timestamp as an organization-local
// "YYYY-MM-DDTHH:mm" for a datetime-local input.
export function utcToZonedInput(value: string | null | undefined, timezone: string | null | undefined): string {
  if (!value) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: orgTimezone(timezone), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// "7h 05m" from minutes.
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
