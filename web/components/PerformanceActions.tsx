"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { PerformanceGoal } from "@/lib/performance";
function errorMessage(error: unknown) {
  return (
    (error as { message?: string })?.message ??
    "Unable to save. Reload to check the current record."
  );
}
export function PerformanceMessageForm({
  instanceId,
  hr,
}: {
  instanceId: string;
  hr: boolean;
}) {
  const router = useRouter(),
    lock = useRef(false),
    retry = useRef<{ payload: string; key: string } | null>(null);
  const [body, setBody] = useState(""),
    [kind, setKind] = useState(hr ? "hr_response" : "employee_comment"),
    [resolve, setResolve] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const payload = JSON.stringify([kind, body, resolve]);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      const { error } = await createClient().rpc("add_performance_message", {
        p_instance_id: instanceId,
        p_kind: kind,
        p_body: body,
        p_client_request_id: retry.current.key,
        p_resolve: resolve,
      });
      if (error) throw error;
      retry.current = null;
      setBody("");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm">
        This thread is shared with the employee and authorised review
        participants. Use it for questions, explanations or a visible
        correction; original reviews stay unchanged.
      </p>
      {hr && (
        <label className="label">
          Message type
          <select
            className="input"
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="hr_response">HR response</option>
            <option value="amendment">HR amendment / correction</option>
          </select>
        </label>
      )}
      <label className="label">
        {hr ? "Response or correction" : "Comment / request for HR review"}
        <textarea
          className="input"
          required
          minLength={3}
          maxLength={4000}
          rows={4}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {hr && (
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={resolve}
            disabled={busy}
            onChange={(e) => setResolve(e.target.checked)}
          />
          Mark the employee’s query resolved with this response
        </label>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button className="btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Post shared message"}
      </button>
    </form>
  );
}
export function ReviewerResolutionForm({
  reviewerId,
  people,
}: {
  reviewerId: string;
  people: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [person, setPerson] = useState(""),
    [waive, setWaive] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc(
        "resolve_performance_reviewer",
        {
          p_reviewer_id: reviewerId,
          p_employee_id: person || null,
          p_reason: reason,
          p_waive: waive,
        },
      );
      if (error) throw error;
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border p-3">
      <summary>HR: reassign or waive this pending stage</summary>
      <form onSubmit={submit} className="space-y-3 mt-3">
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={waive}
            disabled={busy}
            onChange={(e) => setWaive(e.target.checked)}
          />
          Waive this stage with a reason
        </label>
        {!waive && (
          <label className="label">
            Replacement reviewer
            <select
              className="input"
              required
              value={person}
              disabled={busy}
              onChange={(e) => setPerson(e.target.value)}
            >
              <option value="">Choose an eligible reviewer</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-sm">
          The replacement needs the relevant performance permission and scope.
          Self-review stays with the employee; at least one independent review
          is retained.
        </p>
        <label className="label">
          Reason
          <textarea
            className="input"
            required
            minLength={3}
            maxLength={1000}
            disabled={busy}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="alert-error">
            {error}
          </p>
        )}
        <button className="btn-secondary" disabled={busy}>
          {busy ? "Saving…" : "Confirm reviewer change"}
        </button>
      </form>
    </details>
  );
}
export function PerformanceGoalForm({
  instanceId,
  goal,
  lead,
  subject,
  creator = true,
}: {
  instanceId: string;
  goal?: PerformanceGoal;
  lead: boolean;
  subject: boolean;
  creator?: boolean;
}) {
  const router = useRouter(),
    lock = useRef(false),
    retry = useRef<{ payload: string; key: string } | null>(null);
  const [action, setAction] = useState(
      goal
        ? goal.status === "proposed"
          ? lead
            ? "agree"
            : "edit"
          : "progress"
        : "propose",
    ),
    [title, setTitle] = useState(goal?.title ?? ""),
    [measure, setMeasure] = useState(goal?.measure ?? ""),
    [date, setDate] = useState(goal?.target_date ?? ""),
    [support, setSupport] = useState(goal?.support ?? ""),
    [progress, setProgress] = useState(String(goal?.progress ?? 0)),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const data = {
        title,
        measure,
        target_date: date,
        support,
        progress: Number(progress),
        note,
      },
      payload = JSON.stringify([goal?.id, action, data, goal?.version]);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      const { error } = await createClient().rpc("update_performance_goal", {
        p_instance_id: instanceId,
        p_goal_id: goal?.id ?? null,
        p_action: action,
        p_data: data,
        p_expected_version: goal?.version ?? null,
        p_client_request_id: retry.current.key,
      });
      if (error) throw error;
      retry.current = null;
      setNote("");
      if (!goal) {
        setTitle("");
        setMeasure("");
        setDate("");
        setSupport("");
      }
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (
    (goal && ["completed", "cancelled"].includes(goal.status)) ||
    (!lead && !subject) ||
    (goal?.status === "proposed" && !lead && !creator)
  )
    return null;
  return (
    <details className="rounded-xl border p-3">
      <summary>
        {goal ? "Update development goal" : "Propose a measurable goal"}
      </summary>
      <form onSubmit={submit} className="space-y-3 mt-3">
        <fieldset disabled={busy} className="space-y-3">
          {goal && (
            <label className="label">
              Action
              <select
                className="input"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                {goal.status === "active" && (
                  <option value="progress">Record progress</option>
                )}
                {goal.status === "proposed" && lead && (
                  <option value="agree">Agree and activate goal</option>
                )}
                {lead && goal.status === "active" && (
                  <option value="complete">Confirm achieved</option>
                )}
                {(lead || (creator && goal.status === "proposed")) && (
                  <>
                    <option value="edit">Edit proposal / goal terms</option>
                    <option value="cancel">Cancel with reason</option>
                  </>
                )}
              </select>
            </label>
          )}
          {(!goal || action === "edit") && (
            <>
              <label className="label">
                Goal title
                <input
                  required
                  minLength={3}
                  maxLength={200}
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="label">
                Measurable success criteria
                <textarea
                  required
                  minLength={3}
                  maxLength={2000}
                  className="input"
                  value={measure}
                  onChange={(e) => setMeasure(e.target.value)}
                />
              </label>
              <label className="label">
                Target date
                <input
                  required
                  type="date"
                  className="input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label className="label">
                Support needed
                <textarea
                  maxLength={2000}
                  className="input"
                  value={support}
                  onChange={(e) => setSupport(e.target.value)}
                />
              </label>
            </>
          )}
          {goal && action === "progress" && (
            <label className="label">
              Progress (%)
              <input
                required
                type="number"
                min={0}
                max={100}
                step={1}
                className="input"
                value={progress}
                onChange={(e) => setProgress(e.target.value)}
              />
            </label>
          )}
          <label className="label">
            Update / reason
            <textarea
              required
              minLength={3}
              maxLength={2000}
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <p className="text-sm">
            Shared with the employee and authorised performance participants.
            Agreement and completion need an independent leader; goal activity
            does not alter the appraisal rating.
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="alert-error">
            {error}
          </p>
        )}
        <button className="btn-secondary" disabled={busy}>
          {busy ? "Saving…" : "Save goal update"}
        </button>
      </form>
    </details>
  );
}
export function PerformanceCycleResolution({ cycleId }: { cycleId: string }) {
  const router = useRouter();
  const [action, setAction] = useState("close"),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc("resolve_performance_cycle", {
        p_cycle_id: cycleId,
        p_action: action,
        p_reason: reason,
      });
      if (error) throw error;
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Close or cancel cycle</summary>
      <form onSubmit={submit} className="space-y-3 mt-3">
        <label className="label">
          Outcome
          <select
            className="input"
            disabled={busy}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="close">
              Close after every checkpoint is resolved
            </option>
            <option value="cancel">
              Cancel unfinished checkpoints; retain history
            </option>
          </select>
        </label>
        <label className="label">
          Employee-visible reason
          <textarea
            required
            minLength={3}
            maxLength={1000}
            className="input"
            disabled={busy}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="alert-error">
            {error}
          </p>
        )}
        <button className="btn-secondary" disabled={busy}>
          {busy ? "Saving…" : "Confirm cycle outcome"}
        </button>
      </form>
    </details>
  );
}
