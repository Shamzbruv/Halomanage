"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { formatMinutes } from "@/lib/timezone";
import { BREAK_LABEL, breakAllowanceLabel, breakStatus, formatDuration, workedSeconds, type BreakType, type ClockView } from "@/lib/clock";

// The live clock: a ticking worked-time counter, a countdown for lunch and
// breaks that turns red once the allowance (+ grace) is used up, and the
// clock/break actions. Every timestamp is set by the server
// (clock_in/clock_out/start_break/end_break); the timers only display,
// corrected by the server's clock so a wrong device clock can't skew them.

// "Now" on the server's clock, ticking every second. Null until mounted, so
// the server render and the first client render match.
function useServerNow(serverNow: string): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const offset = Date.parse(serverNow) - Date.now();
    const tick = () => setNow(Date.now() + offset);
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [serverNow]);
  return now;
}

function useClockActions() {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(action: "clock_in" | "clock_out" | "start_break" | "end_break", args: Record<string, unknown> = {}, key: string = action) {
    setLoading(key);
    setError(null);
    const { error: rpcError } = await createClient().rpc(action, args);
    if (rpcError) setError(rpcError.message);
    else router.refresh();
    setLoading(null);
  }
  return { run, loading, error };
}

function BreakButton({ view, type, run, loading }: { view: ClockView; type: BreakType; run: ReturnType<typeof useClockActions>["run"]; loading: string | null }) {
  const allowance = breakAllowanceLabel(view.state, type);
  const key = `start_${type}`;
  return (
    <button type="button" className="btn-secondary w-full" disabled={loading !== null} onClick={() => run("start_break", { p_type: type }, key)}
      title={allowance.extra ? `You've used ${allowance.perShift === 1 ? "your" : `all ${allowance.perShift}`} ${type === "lunch" ? "lunch" : "breaks"} for this shift — another is reported to your manager.` : undefined}>
      {loading === key ? "Starting…" : allowance.extra ? `Extra ${type}` : `${type === "lunch" ? "Lunch" : "Break"} · ${allowance.minutes} min`}
    </button>
  );
}

// The body shared by the top-bar dropdown and the clock cards.
export function ClockPanel({ view, compact = false }: { view: ClockView; compact?: boolean }) {
  const { state, labels } = view;
  const now = useServerNow(state.server_now);
  const { run, loading, error } = useClockActions();
  const status = now !== null ? breakStatus(state, now) : null;
  const worked = now !== null ? workedSeconds(state, now) : null;
  const b = state.current_break;
  const lunchUsed = breakAllowanceLabel(state, "lunch");
  const breakUsed = breakAllowanceLabel(state, "break");

  return (
    <div className={`clock-panel${compact ? " compact" : ""}`}>
      {!state.session && (
        <div className="clock-readout">
          <small>Off the clock</small>
          <strong className="clock-figure muted">Not started</strong>
          <span className="clock-meta">{state.can_clock ? "Your timer starts when you clock in." : "Your role doesn't record time in HaloManage."}</span>
        </div>
      )}

      {state.session && !b && (
        <div className="clock-readout">
          <small>Worked this shift</small>
          <strong className="clock-figure" aria-live="off">{worked !== null ? formatDuration(worked) : "—:—"}</strong>
          <span className="clock-meta">In at {labels.clockIn}{labels.shift ? ` · shift ${labels.shift}` : ""}</span>
        </div>
      )}

      {state.session && b && (
        <div className={`clock-readout break-${status?.phase ?? "ok"}`}>
          <small>{BREAK_LABEL[b.type]}{status?.extra ? " · extra (not in your allowance)" : ` · ${b.allowed_minutes} min allowed`}</small>
          <strong className="clock-figure" aria-live="off">
            {status === null ? "—:—" : status.phase === "ok" ? formatDuration(status.remaining) : `+${formatDuration(-status.remaining)}`}
          </strong>
          <span className="clock-meta">
            {status === null ? "" : status.phase === "ok" ? "left" : status.phase === "grace" ? "Time's up — please head back now" : `over your ${b.type} · your manager can see this`}
          </span>
          {status && status.allowed > 0 && <span className="clock-progress" aria-hidden="true"><span style={{ width: `${Math.min(100, (status.elapsed / status.allowed) * 100)}%` }} /></span>}
          <span className="clock-meta">Started {labels.breakStarted} · worked {worked !== null ? formatDuration(worked) : "—"} so far</span>
        </div>
      )}

      {state.session && state.can_clock && (
        <div className="clock-actions">
          {b
            ? <button type="button" className="btn-primary w-full" disabled={loading !== null} onClick={() => run("end_break")}>{loading === "end_break" ? "Ending…" : `End ${b.type}`}</button>
            : <div className="clock-break-buttons"><BreakButton view={view} type="lunch" run={run} loading={loading} /><BreakButton view={view} type="break" run={run} loading={loading} /></div>}
          <button type="button" className="btn-danger w-full" disabled={loading !== null} onClick={() => run("clock_out")}>{loading === "clock_out" ? "Clocking out…" : "Clock out"}</button>
          {!b && <p className="clock-allowance">Today: lunch {lunchUsed.used}/{lunchUsed.perShift} · breaks {breakUsed.used}/{breakUsed.perShift}{state.allowances.short_breaks_paid ? " · short breaks are paid" : ""}</p>}
        </div>
      )}
      {!state.session && state.can_clock && (
        <div className="clock-actions"><button type="button" className="btn-primary w-full" disabled={loading !== null} onClick={() => run("clock_in")}>{loading === "clock_in" ? "Clocking in…" : "Clock in"}</button></div>
      )}

      {state.makeup_owed_minutes > 0 && (
        <p className="clock-notice">You owe <strong>{state.makeup_owed_minutes} min</strong> of make-up time — work it before or after your shift by {labels.makeupDue}. It&apos;s credited automatically.</p>
      )}
      {state.pending_violations > 0 && (
        <p className="clock-notice muted">{state.pending_violations === 1 ? "A break that ran over is" : `${state.pending_violations} breaks that ran over are`} waiting for your manager&apos;s review.</p>
      )}
      {error && <p className="alert-error" role="alert">{error}</p>}
    </div>
  );
}

// Top-bar pill: worked time, or the lunch/break countdown; opens the panel.
export function ClockWidget({ view }: { view: ClockView }) {
  const { state } = view;
  const now = useServerNow(state.server_now);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!state.session && !state.can_clock) return null;
  const status = now !== null ? breakStatus(state, now) : null;
  const b = state.current_break;
  let tone = "off";
  let text = "Off the clock";
  if (state.session && !b) {
    tone = "working";
    text = now !== null ? formatDuration(workedSeconds(state, now)) : "Working";
  } else if (b) {
    tone = status?.phase === "over" ? "over" : status?.phase === "grace" ? "grace" : "break";
    text = status === null ? BREAK_LABEL[b.type]
      : status.phase === "ok" ? `${BREAK_LABEL[b.type]} ${formatDuration(status.remaining)} left`
      : status.phase === "grace" ? `${BREAK_LABEL[b.type]} · time's up`
      : `${BREAK_LABEL[b.type]} +${formatDuration(-status.remaining)} over`;
  }

  return (
    <div className="clock-widget" ref={ref}>
      <button type="button" className={`clock-pill ${tone}`} aria-expanded={open} aria-controls="clock-popover" onClick={() => setOpen((value) => !value)}
        aria-label={`Time clock: ${text}. Open clock controls`}>
        <span className="clock-dot" aria-hidden="true" />
        <Icon name="clock" size={15} />
        <span className="clock-pill-text">{text}</span>
        {state.makeup_owed_minutes > 0 && tone !== "over" && <span className="clock-pill-flag" title="Make-up time owed">{state.makeup_owed_minutes}m owed</span>}
      </button>
      {open && (
        <div className="clock-popover" id="clock-popover" role="dialog" aria-label="Time clock">
          <ClockPanel view={view} compact />
          <Link className="table-action" href="/time" onClick={() => setOpen(false)}>Schedule, history &amp; corrections →</Link>
        </div>
      )}
    </div>
  );
}

// Someone else's lunch/break, for the manager's day view: time left, or how
// far over. Rendered after mount (it depends on the current time).
export function LiveBreakBadge({ type, startedAt, allowedMinutes, graceMinutes }: { type: BreakType; startedAt: string; allowedMinutes: number; graceMinutes: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
  const label = BREAK_LABEL[type];
  if (now === null) return <span className="badge badge-gold">On {type}</span>;
  const remaining = allowedMinutes * 60 - (now - Date.parse(startedAt)) / 1000;
  if (remaining > 0) return <span className="badge badge-gold">{label} · {formatDuration(remaining)} left</span>;
  if (-remaining <= graceMinutes * 60) return <span className="badge badge-gold">{label} · time&apos;s up</span>;
  return <span className="badge badge-ruby">{label} · {formatDuration(-remaining)} over</span>;
}

// A period total (finished shifts) plus the shift in progress, ticking.
export function LiveWorkedMinutes({ view, baseMinutes }: { view: ClockView; baseMinutes: number }) {
  const now = useServerNow(view.state.server_now);
  const live = now !== null && view.state.session ? Math.floor(workedSeconds(view.state, now) / 60) : 0;
  return <>{formatMinutes(baseMinutes + live)}</>;
}
