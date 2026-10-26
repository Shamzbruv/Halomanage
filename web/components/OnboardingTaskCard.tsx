import Link from "next/link";
import type { OnboardingTask } from "@/lib/onboarding";
import { onboardingStatus } from "@/lib/onboarding";
import { formatDateTime, todayIn } from "@/lib/timezone";
import { DocumentDownloadButton } from "./DocumentDownloadButton";
export function OnboardingTaskCard({
  task,
  timezone,
  detail = false,
}: {
  task: OnboardingTask;
  timezone?: string;
  detail?: boolean;
}) {
  const closed = ["completed", "skipped"].includes(task.status),
    overdue =
      !closed &&
      task.run_status !== "cancelled" &&
      task.due_date &&
      task.due_date < todayIn(timezone),
    response = task.response;
  return (
    <article className="card space-y-3">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <small className="eyebrow">
            {task.subject_name} ·{" "}
            {task.phase?.replaceAll("_", " ") || "Onboarding"}
          </small>
          <h2 className="font-semibold text-lg">{task.title}</h2>
          <p className="text-sm">
            {task.template_name} · v{task.template_version_number} ·{" "}
            {task.step_type.replaceAll("_", " ")} ·{" "}
            {task.assignee_type.toUpperCase()} ·{" "}
            {task.assignee_label || "Awaiting an owner"}
          </p>
        </div>
        <span className="badge badge-neutral">
          {task.run_status === "cancelled"
            ? "Plan cancelled"
            : onboardingStatus(task.status)}
        </span>
      </div>
      <p className="whitespace-pre-wrap">{task.description}</p>
      <p className="text-sm">
        {task.required ? "Required" : "Optional"}
        {task.due_date
          ? ` · Due ${task.due_date}`
          : " · Waiting for the date used by this step"}
        {task.due_date_locked ? " · HR date override" : ""}
        {overdue ? " · Overdue" : ""}
      </p>
      {task.prerequisites.length > 0 && (
        <div>
          <strong className="text-sm">Prerequisites</strong>
          <ul className="text-sm">
            {task.prerequisites.map((p) => (
              <li key={p.id}>
                {p.title} — {onboardingStatus(p.status)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {task.review_document && (
        <div className="flex items-center gap-3">
          <span>Document to review: {task.review_document.title}</span>
          <DocumentDownloadButton
            bucket={task.review_document.bucket}
            path={task.review_document.path}
          />
        </div>
      )}
      {task.review_document_version_id && !task.review_document && (
        <p className="alert-error">
          Ask HR for access to the document assigned to this step.
        </p>
      )}
      {detail &&
        task.files.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center gap-3">
            <span>Evidence: {f.title}</span>
            <DocumentDownloadButton bucket={f.bucket} path={f.path} />
          </div>
        ))}
      {detail && response && (
        <div className="space-y-2">
          {["notes", "skip_reason", "progress_note", "typed_name"].map((key) =>
            typeof response[key] === "string" ? (
              <p key={key} className="whitespace-pre-wrap">
                <strong>{key.replaceAll("_", " ")}: </strong>
                {String(response[key])}
              </p>
            ) : null,
          )}
          {response.answers && typeof response.answers === "object" ? (
            <dl>
              {Object.entries(response.answers).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-semibold">
                    {task.form_schema?.fields.find((f) => f.key === key)
                      ?.label || key}
                  </dt>
                  <dd className="whitespace-pre-wrap">
                    {typeof value === "boolean"
                      ? value
                        ? "Yes"
                        : "No"
                      : String(value ?? "—")}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      )}
      {task.completed_at && (
        <p className="text-sm">
          {task.status === "skipped" ? "Waived" : "Completed"}{" "}
          {formatDateTime(task.completed_at, timezone)} by{" "}
          {task.completed_by_label || "recorded account"}
        </p>
      )}
      {task.signed_at && (
        <p className="text-sm">
          Attestation recorded {formatDateTime(task.signed_at, timezone)}.
          Contract signature requirements are handled separately by HR.
        </p>
      )}
      {!detail && (
        <Link className="btn-secondary" href={`/onboarding/tasks/${task.id}`}>
          Open step
        </Link>
      )}
    </article>
  );
}
