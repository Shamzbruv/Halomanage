"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { addDaysToDate } from "@/lib/timezone";
import type { PerformanceCycle } from "@/lib/performance";
type Option = { id: string; label: string };
export function AppraisalCycleForm({
  organizationId,
  templates,
  people,
  departments = [],
  positions = [],
  today,
  initial,
}: {
  organizationId: string;
  templates: Option[];
  people: Option[];
  departments?: Option[];
  positions?: Option[];
  today: string;
  initial?: PerformanceCycle;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
      name: initial?.name ?? "",
      template_id: initial?.template_id ?? "",
      start_date: initial?.start_date ?? today,
      review_period_start:
        initial?.review_period_start ?? today.slice(0, 8) + "01",
      review_period_end: initial?.review_period_end ?? today,
      self_review_due: initial?.self_review_due ?? addDaysToDate(today, 7),
      supervisor_review_due:
        initial?.supervisor_review_due ?? addDaysToDate(today, 14),
      manager_review_due:
        initial?.manager_review_due ?? addDaysToDate(today, 21),
      acknowledgement_due:
        initial?.acknowledgement_due ?? addDaysToDate(today, 28),
    }),
    [filter, setFilter] = useState<Record<string, string[]>>(
      initial?.employee_filter ?? {},
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await createClient().rpc(
        "save_performance_cycle",
        {
          p_organization_id: organizationId,
          p_cycle_id: initial?.id ?? null,
          p_data: { ...form, employee_filter: filter },
          p_expected_revision: initial?.revision ?? null,
        },
      );
      if (error) throw error;
      if (data?.id) router.push(`/admin/appraisals/cycles/${data.id}`);
      router.refresh();
    } catch (e) {
      setError((e as { message?: string }).message ?? "Unable to save cycle.");
    } finally {
      setBusy(false);
    }
  }
  const multi = (key: string, label: string, options: Option[]) => (
    <label className="label" key={key}>
      {label}
      <select
        multiple
        className="input h-28"
        value={filter[key] ?? []}
        onChange={(e) =>
          setFilter({
            ...filter,
            [key]: Array.from(e.target.selectedOptions, (o) => o.value),
          })
        }
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="text-sm">
        Empty selection includes all eligible matches.
      </span>
    </label>
  );
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <label className="label">
          Cycle name
          <input
            className="input"
            required
            maxLength={160}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="label">
          Template
          <select
            required
            className="input"
            value={form.template_id}
            onChange={(e) => setForm({ ...form, template_id: e.target.value })}
          >
            <option value="">Choose an active template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries({
            review_period_start: "Performance period starts",
            review_period_end: "Performance period ends",
            start_date: "Cycle opens for reviews",
            self_review_due: "Self-review due",
            supervisor_review_due: "Supervisor review due",
            manager_review_due: "Manager / HR review due",
            acknowledgement_due: "Employee response due",
          }).map(([key, label]) => (
            <label className="label" key={key}>
              {label}
              <input
                type="date"
                required
                className="input"
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="text-sm">
          Deadlines use the employer’s calendar. Late reviews stay possible and
          visible for HR follow-up. Future opening dates prevent early
          submission.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {multi("employee_ids", "Specific employees", people)}
          {multi("org_unit_ids", "Departments / units", departments)}
          {multi("position_ids", "Positions", positions)}
          {multi("status", "Eligible statuses", [
            { id: "active", label: "Active" },
            { id: "leave", label: "On leave" },
          ])}
          {multi(
            "employment_types",
            "Employment types",
            ["full_time", "part_time", "contract", "temporary", "intern"].map(
              (id) => ({ id, label: id.replaceAll("_", " ") }),
            ),
          )}
        </div>
        <p className="text-sm">
          Filters combine across categories. Employees on leave remain eligible
          unless you deliberately narrow the status filter. Linked employee
          accounts are required. Preview the final roster before launch.
        </p>
      </fieldset>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button className="btn-primary" disabled={busy || !templates.length}>
        {busy
          ? "Saving…"
          : initial
            ? "Save draft settings"
            : "Create draft cycle"}
      </button>
    </form>
  );
}
