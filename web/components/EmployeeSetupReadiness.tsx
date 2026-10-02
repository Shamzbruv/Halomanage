import Link from "next/link";
import { Icon } from "@/components/Icon";
import { SETUP_GROUPS, accountLabel, setupHref, type SetupReadiness } from "@/lib/employeeSetup";
import { formatDate as formatOrgDate } from "@/lib/timezone";

function formatDate(value: string | null, timezone: string | undefined) {
  return value ? formatOrgDate(value, timezone, { month: "short", day: "numeric", year: "numeric" }) : null;
}

// Renders get_employee_setup_readiness() — it never decides readiness
// itself. Each blocker links straight to the field that needs attention.
export function EmployeeSetupReadiness({
  employeeId,
  readiness,
  showBlockers = true,
  timezone,
}: {
  employeeId: string;
  readiness: SetupReadiness;
  showBlockers?: boolean;
  timezone: string | undefined;
}) {
  const remaining = readiness.blockers.length;
  const invitedAt = formatDate(readiness.account.invited_at, timezone);
  const lastSignIn = formatDate(readiness.account.last_sign_in_at, timezone);

  return (
    <section className="setup-status" aria-label="Employee setup status">
      <div className="setup-status-head">
        <span>HR setup</span>
        <strong>{readiness.percent}%</strong>
      </div>
      <div className="setup-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness.percent} aria-label="Employee setup progress">
        <span style={{ width: `${readiness.percent}%` }} />
      </div>
      <p className="setup-status-summary">
        {readiness.ready
          ? readiness.account.state === "not_invited" ? "Ready to invite." : "Setup complete."
          : `${remaining} item${remaining === 1 ? "" : "s"} remaining before invitation`}
      </p>

      <ul className="setup-checklist">
        {SETUP_GROUPS.map((group) => {
          const items = readiness.items.filter((item) => group.sections.includes(item.section));
          const required = items.filter((item) => item.required);
          const done = required.length > 0 ? required.every((item) => item.complete) : items.every((item) => item.complete);
          const optionalOnly = required.length === 0;
          return (
            <li key={group.label} className={done ? "done" : optionalOnly ? "optional" : ""}>
              <span aria-hidden="true">{done ? <Icon name="check" size={14} /> : "○"}</span>
              <Link href={`/admin/employees/${employeeId}/setup?step=${group.step}`}>{group.label}</Link>
              {optionalOnly && !done && <small>optional</small>}
            </li>
          );
        })}
      </ul>

      {showBlockers && readiness.blockers.length > 0 && (
        <div className="setup-blockers">
          <p>Needs attention</p>
          <ul>
            {readiness.blockers.map((blocker) => (
              <li key={blocker.code}>
                <Link href={setupHref(employeeId, blocker)}>{blocker.message}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showBlockers && readiness.warnings.length > 0 && (
        <div className="setup-warnings">
          <p>Recommended</p>
          <ul>
            {readiness.warnings.map((warning) => (
              <li key={warning.code}>
                <Link href={setupHref(employeeId, warning)}>{warning.label} not entered</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="setup-account">
        <span>Account</span>
        <strong>{accountLabel(readiness.account)}</strong>
        {readiness.account.state === "invited" && invitedAt && <small>Invitation sent {invitedAt} — awaiting acceptance</small>}
        {readiness.account.state === "active" && <small>{lastSignIn ? `Last signed in ${lastSignIn}` : "Signed in"}</small>}
      </div>
    </section>
  );
}
