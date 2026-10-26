"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { OnboardingTask } from "@/lib/onboarding";
export function OnboardingTaskForm({ task }: { task: OnboardingTask }) {
  const router = useRouter(),
    submitting = useRef(false),
    upload = useRef<{ key: string; path: string; uploaded: boolean } | null>(
      null,
    );
  const [mode, setMode] = useState(
      task.can_respond
        ? "complete"
        : task.can_evidence
          ? "evidence"
          : "progress",
    ),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [typedName, setTypedName] = useState(""),
    [answers, setAnswers] = useState<Record<string, unknown>>({}),
    [file, setFile] = useState<File | null>(null),
    [document, setDocument] = useState(""),
    [due, setDue] = useState(task.due_date ?? ""),
    [progress, setProgress] = useState("in_progress"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const blocked = task.prerequisites.some(
    (p) => !["completed", "skipped"].includes(p.status),
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const db = createClient();
    try {
      if (mode === "evidence") {
        if (!file && !document) throw new Error("Choose a document or a file.");
        if (file) {
          if (
            !["application/pdf", "image/png", "image/jpeg"].includes(
              file.type,
            ) ||
            file.size > 15 * 1024 * 1024 ||
            file.size === 0
          )
            throw new Error("Use a PDF, PNG or JPEG up to 15 MB.");
          const key = [file.name, file.size, file.lastModified].join(":");
          if (upload.current?.key !== key)
            upload.current = {
              key,
              path: `${task.organization_id}/${task.id}/${crypto.randomUUID()}.${file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg"}`,
              uploaded: false,
            };
          if (!upload.current.uploaded) {
            const { error } = await db.storage
              .from("onboarding-evidence")
              .upload(upload.current.path, file, {
                contentType: file.type,
                upsert: false,
              });
            if (
              error &&
              String((error as { statusCode?: string }).statusCode) !== "409"
            )
              throw error;
            upload.current.uploaded = true;
          }
          const { error } = await db.rpc("register_onboarding_file", {
            p_task_id: task.id,
            p_storage_path: upload.current.path,
            p_file_name: file.name,
            p_mime_type: file.type,
            p_file_size: file.size,
          });
          if (error) throw error;
          upload.current = null;
          setFile(null);
        }
        if (document) {
          const { error } = await db.rpc("attach_onboarding_task_document", {
            p_task_id: task.id,
            p_document_id: document,
          });
          if (error) throw error;
          setDocument("");
        }
      } else {
        const name =
          mode === "skip"
            ? "skip_onboarding_task"
            : mode === "progress"
              ? "update_onboarding_task_progress"
              : mode === "schedule"
                ? "reschedule_onboarding_task"
                : "complete_onboarding_task";
        const args =
          mode === "skip"
            ? { p_task_id: task.id, p_reason: note }
            : mode === "progress"
              ? { p_task_id: task.id, p_status: progress, p_note: note }
              : mode === "schedule"
                ? {
                    p_task_id: task.id,
                    p_due_date: due || null,
                    p_reason: note,
                  }
                : {
                    p_task_id: task.id,
                    p_completion_data: {
                      notes: note.trim() || null,
                      confirmed,
                      typed_name: typedName.trim() || null,
                      answers,
                    },
                  };
        const { error } = await db.rpc(name, args);
        if (error) throw error;
      }
      setNote("");
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ??
          "Unable to save. You can retry or reload the step.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (
    task.run_status === "cancelled" ||
    ["completed", "skipped"].includes(task.status)
  )
    return null;
  if (!task.can_respond && !task.can_manage)
    return (
      <p className="card">
        This step is with its assigned owner. Contact HR if the assignment needs
        correction.
      </p>
    );
  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Update this step</h2>
      <form onSubmit={submit} className="space-y-3">
        <fieldset disabled={busy} className="space-y-3">
          <label className="label">
            Action
            <select
              className="input"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setError(null);
              }}
            >
              {task.can_respond && (
                <option value="complete">Complete step</option>
              )}
              {task.can_evidence && (
                <option value="evidence">Attach evidence</option>
              )}
              <option value="progress">Report progress or a blocker</option>
              {task.can_skip && (
                <option value="skip">
                  {task.required
                    ? "HR waiver of required step"
                    : "Waive optional step"}
                </option>
              )}
              {task.can_manage && (
                <option value="schedule">Change due date</option>
              )}
            </select>
          </label>
          {mode === "complete" && (
            <>
              {blocked && (
                <p className="alert-error">
                  Prerequisites are unfinished. You can attach evidence or
                  report a blocker now; completion will unlock when they are
                  resolved.
                </p>
              )}
              {task.form_schema?.fields.map((f) => (
                <label key={f.key} className="label">
                  {f.label}
                  {f.required ? " *" : ""}
                  {f.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      required={f.required}
                      checked={answers[f.key] === true}
                      onChange={(e) =>
                        setAnswers({ ...answers, [f.key]: e.target.checked })
                      }
                    />
                  ) : (
                    <input
                      className="input"
                      type={
                        f.type === "number"
                          ? "number"
                          : f.type === "date"
                            ? "date"
                            : "text"
                      }
                      required={f.required}
                      maxLength={2000}
                      step={f.type === "number" ? "any" : undefined}
                      value={String(answers[f.key] ?? "")}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [f.key]:
                            f.type === "number" && e.target.value !== ""
                              ? Number(e.target.value)
                              : e.target.value,
                        })
                      }
                    />
                  )}
                </label>
              ))}
              {(task.requires_signature ||
                ["signature", "acknowledgement", "document_review"].includes(
                  task.step_type,
                )) && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm I reviewed the instructions and any assigned
                  document, and completed this step myself.
                </label>
              )}
              {(task.requires_signature || task.step_type === "signature") && (
                <>
                  <label className="label">
                    Your name for this attestation
                    <input
                      className="input"
                      required
                      minLength={2}
                      maxLength={200}
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                    />
                  </label>
                  <p className="text-sm">
                    This records your signed-in account, name and time. Follow
                    HR’s separate process for contracts requiring a formal
                    signature.
                  </p>
                </>
              )}
            </>
          )}
          {mode === "evidence" ? (
            <>
              <label className="label">
                Upload evidence (PDF, PNG or JPEG, up to 15 MB)
                <input
                  className="input"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              {task.documents.length > 0 && (
                <label className="label">
                  Or attach an accessible document
                  <select
                    className="input"
                    value={document}
                    onChange={(e) => setDocument(e.target.value)}
                  >
                    <option value="">Choose document</option>
                    {task.documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="text-sm">
                Files are private to the employee, the assigned owner and
                authorized HR. Attach only what this step needs. The submitted
                version is preserved.
              </p>
            </>
          ) : (
            <>
              <label className="label">
                {mode === "complete"
                  ? "Completion note"
                  : "Reason / support needed"}
                <textarea
                  className="input"
                  rows={4}
                  maxLength={4000}
                  minLength={3}
                  required={
                    mode !== "complete" ||
                    (task.step_type === "form" && !task.form_schema) ||
                    ["meeting", "training", "approval", "checkpoint"].includes(
                      task.step_type,
                    )
                  }
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <p className="text-sm">
                Keep notes factual. Use the official HR record for identity
                numbers, bank details or confidential HR assessments.
              </p>
            </>
          )}
          {mode === "progress" && (
            <label className="label">
              Status
              <select
                className="input"
                value={progress}
                onChange={(e) => setProgress(e.target.value)}
              >
                <option value="in_progress">In progress</option>
                <option value="blocked">Blocked — support needed</option>
                <option value="pending">Pending</option>
              </select>
            </label>
          )}
          {mode === "schedule" && (
            <label className="label">
              Due date (clear to restore the template anchor)
              <input
                type="date"
                className="input"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="alert-error">
            {error}
          </p>
        )}
        <button
          className="btn-primary"
          disabled={busy || (mode === "complete" && blocked)}
        >
          {busy
            ? "Saving…"
            : mode === "complete"
              ? "Confirm completion"
              : "Save update"}
        </button>
      </form>
    </section>
  );
}
