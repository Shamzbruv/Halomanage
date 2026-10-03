"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DAY_NAMES, shiftHours } from "@/lib/attendance";

// Time & Attendance setup. Policies and holidays are written directly
// (RLS: attendance.manage_policies; audited by trigger); schedules and
// assignments go through save_work_schedule()/set_work_schedule_active()/
// assign_employee_schedule(), which validate and audit.

export type PolicyValues = {
  id: string;
  name: string;
  grace_period_minutes: number;
  early_departure_grace_minutes: number;
  break_deduction: "recorded" | "scheduled" | "none";
  correction_window_days: number;
  missing_clock_out_after_hours: number;
  missing_clock_out_action: "flag" | "auto_close";
  overtime_requires_approval: boolean;
  lunch_minutes: number;
  lunches_per_shift: number;
  short_break_minutes: number;
  short_breaks_per_shift: number;
  short_breaks_paid: boolean;
  break_overrun_grace_minutes: number;
};

function Feedback({ error, message }: { error: string | null; message: string | null }) {
  if (error) return <p role="alert" className="alert-error">{error}</p>;
  if (message) return <p role="status" className="text-xs text-emerald-700">{message}</p>;
  return null;
}

export function AttendancePolicyForm({ initial }: { initial: PolicyValues }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const set = <K extends keyof PolicyValues>(key: K, value: PolicyValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const { id, ...rest } = values;
    const { error: updateError } = await createClient().from("attendance_policies").update({ ...rest, name: rest.name.trim() || "Standard attendance" }).eq("id", id);
    if (updateError) setError(updateError.message);
    else {
      setMessage("Attendance policy saved. It applies to new clock-ins and recalculated records from now on.");
      router.refresh();
    }
    setLoading(false);
  }

  const number = (key: keyof PolicyValues, label: string, help: string, min: number, max: number, step = 1) => (
    <div>
      <label className="label" htmlFor={`policy-${key}`}>{label}</label>
      <input id={`policy-${key}`} className="input" type="number" min={min} max={max} step={step} required value={values[key] as number} onChange={(e) => set(key, Number(e.target.value) as never)} />
      <p className="field-help">{help}</p>
    </div>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div><label className="label" htmlFor="policy-name">Policy name</label><input id="policy-name" className="input" value={values.name} maxLength={120} onChange={(e) => set("name", e.target.value)} /></div>
        {number("grace_period_minutes", "Lateness grace (minutes)", "Clocking in within this many minutes of the shift start isn't counted as late.", 0, 240)}
        {number("early_departure_grace_minutes", "Early-departure grace (minutes)", "Leaving within this many minutes of the shift end isn't flagged.", 0, 240)}
        <div>
          <label className="label" htmlFor="policy-break">How breaks count</label>
          <select id="policy-break" className="input" value={values.break_deduction} onChange={(e) => set("break_deduction", e.target.value as PolicyValues["break_deduction"])}>
            <option value="recorded">Deduct lunch (and unpaid breaks) as people record them</option>
            <option value="scheduled">Deduct the schedule&apos;s break, or recorded unpaid time if longer</option>
            <option value="none">Don&apos;t deduct breaks (all paid)</option>
          </select>
          <p className="field-help">Worked time = clock-in to clock-out minus unpaid break time. Time over an allowance is unpaid unless a manager excuses it or asks for it to be made up.</p>
        </div>
        {number("correction_window_days", "Correction window (days)", "How far back employees can request a correction to their own records.", 1, 365)}
        {number("missing_clock_out_after_hours", "Missing clock-out after (hours)", "A shift still open this long after clock-in is treated as a forgotten clock-out.", 1, 48, 0.5)}
        <div>
          <label className="label" htmlFor="policy-missing">When a clock-out is missing</label>
          <select id="policy-missing" className="input" value={values.missing_clock_out_action} onChange={(e) => set("missing_clock_out_action", e.target.value as PolicyValues["missing_clock_out_action"])}>
            <option value="flag">Flag it for the employee and manager to correct</option>
            <option value="auto_close">Close it at the scheduled end (or the limit) and flag it for review</option>
          </select>
          <p className="field-help">Either way the record is marked for review — nothing is silently assumed.</p>
        </div>
      </div>
      <fieldset className="rounded-lg border border-stone-100 p-3">
        <legend className="label px-1">Lunch &amp; breaks</legend>
        <p className="field-help mb-3">Employees see a countdown when they start a lunch or break. Going past it (plus the leeway) is reported to them and their manager — while it&apos;s happening and when it ends — and the manager excuses it, deducts the minutes from pay, or has the time made up.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {number("lunch_minutes", "Lunch length (minutes)", "How long a lunch may last.", 0, 240)}
          {number("lunches_per_shift", "Lunches per shift", "A lunch beyond this is reported as extra.", 0, 3)}
          {number("break_overrun_grace_minutes", "Leeway before it counts (minutes)", "A lunch or break this close to its allowance isn't reported.", 0, 30)}
          {number("short_break_minutes", "Break length (minutes)", "How long a short break may last.", 0, 120)}
          {number("short_breaks_per_shift", "Breaks per shift", "A break beyond this is reported as extra.", 0, 10)}
          <label className="flex items-start gap-2 self-center text-sm text-stone-700">
            <input type="checkbox" className="mt-0.5" checked={values.short_breaks_paid} onChange={(e) => set("short_breaks_paid", e.target.checked)} />
            <span>Short breaks are paid<small className="block text-xs text-stone-500">Lunch is always unpaid time.</small></span>
          </label>
        </div>
        <p className="field-help mt-3">Set each schedule&apos;s unpaid break to the lunch length so expected hours line up. Changes apply to lunches and breaks started from now on.</p>
      </fieldset>
      <label className="flex items-start gap-2 rounded-lg border border-stone-100 p-2.5 text-sm text-stone-700">
        <input type="checkbox" className="mt-0.5" checked={values.overtime_requires_approval} onChange={(e) => set("overtime_requires_approval", e.target.checked)} />
        <span>Overtime needs a manager&apos;s approval<small className="block text-xs text-stone-500">Time worked beyond the scheduled shift (or any work on a scheduled day off) waits in Team attendance until a manager approves it.</small></span>
      </label>
      <Feedback error={error} message={message} />
      <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Save attendance policy"}</button>
    </form>
  );
}

type ShiftDraft = { enabled: boolean; start: string; end: string; breakMinutes: number };
export type ScheduleRow = { id: string; name: string; description: string | null; is_default: boolean; is_active: boolean; shifts: { day_of_week: number; start_time: string; end_time: string; break_minutes: number }[]; assigned: number };

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function draftFrom(schedule: ScheduleRow | null): ShiftDraft[] {
  return Array.from({ length: 7 }, (_, day) => {
    const shift = schedule?.shifts.find((s) => s.day_of_week === day);
    if (shift) return { enabled: true, start: shift.start_time.slice(0, 5), end: shift.end_time.slice(0, 5), breakMinutes: shift.break_minutes };
    return { enabled: !schedule && day >= 1 && day <= 5, start: "09:00", end: "17:00", breakMinutes: 60 };
  });
}

function ScheduleForm({ organizationId, schedule, onDone }: { organizationId: string; schedule: ScheduleRow | null; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(schedule?.name ?? "");
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [isDefault, setIsDefault] = useState(schedule?.is_default ?? false);
  const [days, setDays] = useState(() => draftFrom(schedule));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (day: number, patch: Partial<ShiftDraft>) => setDays((all) => all.map((d, i) => (i === day ? { ...d, ...patch } : d)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const shifts = days.flatMap((d, day) => (d.enabled ? [{ day_of_week: day, start_time: d.start, end_time: d.end, break_minutes: d.breakMinutes }] : []));
    const { error: rpcError } = await createClient().rpc("save_work_schedule", {
      p_organization_id: organizationId, p_schedule_id: schedule?.id ?? null, p_name: name, p_description: description, p_is_default: isDefault, p_shifts: shifts,
    });
    setLoading(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-xl border border-stone-100 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div><label className="label" htmlFor="schedule-name">Schedule name</label><input id="schedule-name" className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard week, Night shift" /></div>
        <div><label className="label" htmlFor="schedule-description">Description</label><input id="schedule-description" className="input" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></div>
      </div>
      <div className="shift-editor" role="group" aria-label="Working days">
        {WEEK_ORDER.map((day) => {
          const d = days[day];
          const overnight = d.enabled && d.end <= d.start;
          return (
            <div className="shift-editor-row" key={day}>
              <label><input type="checkbox" checked={d.enabled} onChange={(e) => update(day, { enabled: e.target.checked })} />{DAY_NAMES[day]}</label>
              <div><input className="input" type="time" aria-label={`${DAY_NAMES[day]} start`} disabled={!d.enabled} value={d.start} onChange={(e) => update(day, { start: e.target.value })} /></div>
              <div><input className="input" type="time" aria-label={`${DAY_NAMES[day]} end`} disabled={!d.enabled} value={d.end} onChange={(e) => update(day, { end: e.target.value })} /></div>
              <div><input className="input" type="number" min={0} max={600} aria-label={`${DAY_NAMES[day]} break minutes`} disabled={!d.enabled} value={d.breakMinutes} onChange={(e) => update(day, { breakMinutes: Number(e.target.value) })} /></div>
              <small>{!d.enabled ? "Day off" : overnight ? "Overnight — ends next day" : "min break"}</small>
            </div>
          );
        })}
      </div>
      <label className="flex items-start gap-2 text-sm text-stone-700"><input type="checkbox" className="mt-0.5" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /><span>Default schedule<small className="block text-xs text-stone-500">New hires are placed on it automatically.</small></span></label>
      {schedule && schedule.assigned > 0 && <p className="field-help">Editing hours affects {schedule.assigned} assigned {schedule.assigned === 1 ? "person" : "people"} from their next clock-in. Records already made keep the schedule they were made under.</p>}
      <Feedback error={error} message={null} />
      <div className="flex gap-2"><button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : schedule ? "Save schedule" : "Create schedule"}</button><button type="button" className="btn-secondary" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

export function ScheduleManager({ organizationId, schedules }: { organizationId: string; schedules: ScheduleRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(schedule: ScheduleRow) {
    setError(null);
    const { error: rpcError } = await createClient().rpc("set_work_schedule_active", { p_schedule_id: schedule.id, p_active: !schedule.is_active });
    if (rpcError) setError(rpcError.message);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <Feedback error={error} message={null} />
      {schedules.length === 0 && editing !== "new" && <div className="list-empty">No schedules yet. Create one so attendance can be compared with expected hours.</div>}
      {schedules.map((schedule) => (
        editing === schedule.id
          ? <ScheduleForm key={schedule.id} organizationId={organizationId} schedule={schedule} onDone={() => setEditing(null)} />
          : (
            <article key={schedule.id} className="rounded-xl border border-stone-100 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <strong className="text-sm text-stone-900">{schedule.name}</strong>{" "}
                  {schedule.is_default && <span className="badge badge-emerald">Default</span>}{" "}
                  {!schedule.is_active && <span className="badge badge-neutral">Inactive</span>}
                  <p className="text-xs text-stone-500">{schedule.description ?? ""}{schedule.description ? " · " : ""}{schedule.assigned} assigned</p>
                </div>
                <div className="flex gap-2">
                  {schedule.is_active && <button type="button" className="table-action" onClick={() => setEditing(schedule.id)}>Edit</button>}
                  <button type="button" className="table-action" onClick={() => toggle(schedule)}>{schedule.is_active ? "Deactivate" : "Reactivate"}</button>
                </div>
              </div>
              <div className="schedule-week mt-2">
                {[...schedule.shifts].sort((a, b) => WEEK_ORDER.indexOf(a.day_of_week) - WEEK_ORDER.indexOf(b.day_of_week)).map((shift) => {
                  const hours = shiftHours(shift.start_time, shift.end_time);
                  return <div key={shift.day_of_week}><strong>{DAY_NAMES[shift.day_of_week]}</strong><span>{hours.label}</span><small>{shift.break_minutes} min break{hours.overnight ? " · ends next day" : ""}</small></div>;
                })}
              </div>
            </article>
          )
      ))}
      {editing === "new"
        ? <ScheduleForm organizationId={organizationId} schedule={null} onDone={() => setEditing(null)} />
        : <button type="button" className="btn-secondary" onClick={() => setEditing("new")}>New schedule</button>}
    </div>
  );
}

// dateLabel is formatted on the server (no Intl in client render).
export type HolidayRow = { id: string; name: string; observed_on: string; dateLabel: string; location_id: string | null; is_paid: boolean };

export function HolidayManager({ organizationId, holidays, locations }: { organizationId: string; holidays: HolidayRow[]; locations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [locationId, setLocationId] = useState("");
  const [isPaid, setIsPaid] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await createClient().from("holidays").insert({ organization_id: organizationId, name: name.trim(), observed_on: date, location_id: locationId || null, is_paid: isPaid });
    setLoading(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setName("");
    setDate("");
    router.refresh();
  }

  async function remove(id: string) {
    setError(null);
    const { error: deleteError } = await createClient().from("holidays").delete().eq("id", id);
    if (deleteError) setError(deleteError.message);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="attendance-toolbar">
        <div><label className="label" htmlFor="holiday-name">Holiday</label><input id="holiday-name" className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emancipation Day" /></div>
        <div><label className="label" htmlFor="holiday-date">Date</label><input id="holiday-date" className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="label" htmlFor="holiday-location">Applies to</label><select id="holiday-location" className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">All locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <label className="flex items-center gap-2 text-sm text-stone-700"><input type="checkbox" checked={isPaid} onChange={(e) => setIsPaid(e.target.checked)} />Paid</label>
        <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Adding…" : "Add holiday"}</button>
      </form>
      <Feedback error={error} message={null} />
      <table className="w-full text-sm">
        <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Date</th><th className="pb-3">Holiday</th><th className="pb-3">Applies to</th><th className="pb-3">Paid</th><th className="pb-3" /></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {holidays.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-stone-400">No holidays added. On a holiday, scheduled staff aren&apos;t counted absent.</td></tr>}
          {holidays.map((h) => (
            <tr key={h.id}>
              <td className="py-2">{h.dateLabel}</td>
              <td className="py-2 font-medium text-stone-900">{h.name}</td>
              <td className="py-2 text-stone-600">{h.location_id ? locationName.get(h.location_id) ?? "One location" : "All locations"}</td>
              <td className="py-2">{h.is_paid ? "Yes" : "No"}</td>
              <td className="py-2 text-right"><button type="button" className="table-action" onClick={() => remove(h.id)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type AssignmentRow = { employeeId: string; name: string; employeeNumber: string | null; department: string | null; current: { name: string; since: string } | null; upcoming: { name: string; starts: string } | null };

export function ScheduleAssignments({ rows, schedules, today }: { rows: AssignmentRow[]; schedules: { id: string; name: string }[]; today: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scheduleId, setScheduleId] = useState(schedules[0]?.id ?? "");
  const [startDate, setStartDate] = useState(today);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const visible = rows.filter((r) => !filter || `${r.name} ${r.employeeNumber ?? ""} ${r.department ?? ""} ${r.current?.name ?? "unassigned"}`.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (id: string) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function assign() {
    if (!scheduleId || selected.size === 0) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    const failures: string[] = [];
    for (const employeeId of selected) {
      const { error: rpcError } = await supabase.rpc("assign_employee_schedule", { p_employee_id: employeeId, p_schedule_id: scheduleId, p_start_date: startDate || null });
      if (rpcError) failures.push(`${rows.find((r) => r.employeeId === employeeId)?.name ?? "Employee"}: ${rpcError.message}`);
    }
    setLoading(false);
    if (failures.length) setError(failures.join(" · "));
    else setMessage(`Schedule assigned to ${selected.size} ${selected.size === 1 ? "person" : "people"}.`);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="attendance-toolbar">
        <div><label className="label" htmlFor="assign-filter">Find people</label><input id="assign-filter" className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, number, department or schedule" /></div>
        <div><label className="label" htmlFor="assign-schedule">Schedule</label><select id="assign-schedule" className="input" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>{schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="assign-date">Effective from</label><input id="assign-date" className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
        <button type="button" className="btn-primary" disabled={loading || selected.size === 0 || !scheduleId} onClick={assign}>{loading ? "Assigning…" : `Assign to ${selected.size} selected`}</button>
      </div>
      <Feedback error={error} message={message} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3"><input type="checkbox" aria-label="Select all shown" checked={visible.length > 0 && visible.every((r) => selected.has(r.employeeId))} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((r) => r.employeeId)) : new Set())} /></th><th className="pb-3">Employee</th><th className="pb-3">Department</th><th className="pb-3">Current schedule</th><th className="pb-3">Upcoming change</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {visible.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-stone-400">No one matches.</td></tr>}
            {visible.map((r) => (
              <tr key={r.employeeId}>
                <td className="py-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.employeeId)} onChange={() => toggle(r.employeeId)} /></td>
                <td className="py-2 font-medium text-stone-900">{r.name}<small className="block text-stone-500">{r.employeeNumber ?? ""}</small></td>
                <td className="py-2 text-stone-600">{r.department ?? "—"}</td>
                <td className="py-2">{r.current ? <>{r.current.name}<small className="block text-stone-500">since {r.current.since}</small></> : <span className="text-amber-700">Not assigned</span>}</td>
                <td className="py-2 text-stone-600">{r.upcoming ? `${r.upcoming.name} from ${r.upcoming.starts}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
