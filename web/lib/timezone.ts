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

export function formatDateTime(value: string | Date, timezone: string | null | undefined): string {
  return new Date(value).toLocaleString("en", { timeZone: orgTimezone(timezone) });
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
