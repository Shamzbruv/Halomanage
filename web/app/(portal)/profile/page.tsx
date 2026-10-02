import Link from "next/link";
import { redirect } from "next/navigation";
import { AvatarUpload } from "@/components/AvatarUpload";
import { EmergencyContactsEditor } from "@/components/EmergencyContactsEditor";
import { EmployeePersonalInfoForm, PERSONAL_INFO_COLUMNS, type CollectionSetting } from "@/components/EmployeePersonalInfoForm";
import { HelpTip } from "@/components/HelpTip";
import { Icon } from "@/components/Icon";
import { ProfileForm } from "@/components/ProfileForm";
import {
  ConfirmProfileButton, DownloadMyDataButton, MyRecordRequests, RequestCorrectionButton, RequestDataCopyButton,
} from "@/components/profile/RecordRequestControls";
import { EMPLOYMENT_TYPE_LABELS, identifierTypeLabel, maskIdentifier, type SetupItem } from "@/lib/employeeSetup";
import { formatPhone } from "@/lib/phone";
import type { RecordRequest } from "@/lib/recordRequests";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/timezone";
import { statusBadgeClass } from "@/lib/ui";

type MyRecord = {
  legal_name: string;
  preferred_name: string | null;
  employee_number: string;
  status: string;
  hire_date: string | null;
  probation_end_date: string | null;
  work_email: string | null;
  work_phone: string | null;
  profile_last_confirmed_at: string | null;
  employment_type: string | null;
  position: string | null;
  department: string | null;
  location: string | null;
  supervisor: string | null;
  manager: string | null;
  schedule: string | null;
  settings: {
    collect_gender: CollectionSetting;
    collect_marital_status: CollectionSetting;
    work_phone_editable: boolean;
    privacy_notice_url: string | null;
    can_update_self: boolean;
  };
  profile_items: SetupItem[];
};

function Locked({ children }: { children: React.ReactNode }) {
  return <dd className="mt-0.5 flex items-center gap-1.5 text-stone-900"><span aria-label="Managed by HR" title="Managed by HR">🔒</span>{children}</dd>;
}

// My Profile is the employee's official record (docs/ARCHITECTURE.md "My
// Profile: the employee's official record"): what the employer has on file,
// who owns each piece, what the employee can update, and how to get the
// rest corrected. Everything is read through the employee's own RLS scope
// or get_my_employee_record(); nothing here fetches more PII than it shows.
export default async function ProfilePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const employee = session.employee;
  const timezone = session.organization?.timezone;

  const supabase = await createClient();
  const [{ data: recordData }, { data: privateInfo }, { data: contacts }, { data: identifiers }, { data: requests }] = await Promise.all([
    supabase.rpc("get_my_employee_record"),
    supabase.from("employee_private").select(PERSONAL_INFO_COLUMNS).eq("employee_id", employee.id).maybeSingle(),
    supabase.from("employee_emergency_contacts").select("id, full_name, relationship, phone, alternate_phone, email, is_primary").eq("employee_id", employee.id).order("is_primary", { ascending: false }).order("created_at"),
    supabase.from("employee_identifiers").select("id, identifier_type, label, identifier_value, verified_at").eq("employee_id", employee.id).order("identifier_type"),
    supabase.from("employee_record_requests").select("*").eq("employee_id", employee.id).order("requested_at", { ascending: false }).limit(20),
  ]);
  const record = recordData as MyRecord | null;
  if (!record) redirect("/signup/complete?repair=1");

  const avatarResult = employee.avatar_url
    ? await supabase.storage.from("employee-avatars").createSignedUrl(employee.avatar_url, 3600)
    : null;
  const displayName = `${employee.preferred_name || employee.first_name} ${employee.last_name}`;
  const required = record.profile_items;
  const missing = required.filter((item) => !item.complete);
  const completeness = required.length ? Math.round(((required.length - missing.length) / required.length) * 100) : 100;
  const myRequests = (requests ?? []) as RecordRequest[];
  const canEdit = record.settings.can_update_self;
  const dob = (privateInfo as { date_of_birth?: string | null } | null)?.date_of_birth ?? null;

  const employment: [string, React.ReactNode][] = [
    ["Legal name", record.legal_name],
    ["Employee number", <span key="n" className="font-mono">{record.employee_number}</span>],
    ["Employment status", <span key="s" className="capitalize">{record.status}</span>],
    ["Employment type", record.employment_type ? EMPLOYMENT_TYPE_LABELS[record.employment_type] ?? record.employment_type : "—"],
    ["Position", record.position ?? "—"],
    ["Department", record.department ?? "—"],
    ["Work location", record.location ?? "—"],
    ["Supervisor", record.supervisor ?? "—"],
    ["Manager", record.manager ?? "—"],
    ["Hire date", record.hire_date ? formatDate(`${record.hire_date}T12:00:00Z`, "UTC", { dateStyle: "long" }) : "—"],
    ["Probation end", record.probation_end_date ? formatDate(`${record.probation_end_date}T12:00:00Z`, "UTC", { dateStyle: "long" }) : "—"],
    ["Work email", record.work_email ?? "—"],
    ["Work schedule", record.schedule ?? "—"],
    ["Portal role", session.roleLabels.join(" · ") || "—"],
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="page-intro"><span className="eyebrow">My employee record</span><h1>What your employer has on file about you.</h1><p>See your official record, keep your own details current, and ask HR to correct anything that&apos;s wrong.</p></div>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <AvatarUpload
            employeeId={employee.id}
            organizationId={employee.organization_id}
            currentPath={employee.avatar_url}
            currentUrl={avatarResult?.data?.signedUrl ?? null}
            employeeName={displayName}
          />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold text-stone-900">{displayName}</h2>
            <p className="text-sm text-stone-500"><span className="font-mono">{record.employee_number}</span>{record.position ? ` · ${record.position}` : ""}{record.department ? ` · ${record.department}` : ""}</p>
            <span className={`badge mt-2 ${statusBadgeClass(record.status)}`}>{record.status}</span>
          </div>
        </div>
        <div className="mt-5 grid gap-4 border-t border-stone-100 pt-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase text-stone-400">Profile check</p>
            <p className="mt-1 text-sm text-stone-700">
              {record.profile_last_confirmed_at
                ? <>You last confirmed your details on <strong>{formatDate(record.profile_last_confirmed_at, timezone, { dateStyle: "long" })}</strong>.</>
                : "You haven't confirmed your details yet."}
            </p>
            <div className="mt-2"><ConfirmProfileButton /></div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase text-stone-400">Required information</p>
            <div className="setup-progress mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completeness} aria-label="Required information complete"><span style={{ width: `${completeness}%` }} /></div>
            <p className="mt-1 text-sm text-stone-700">{missing.length === 0 ? "Everything your organization requires is on file." : `Missing: ${missing.map((m) => m.label).join(", ")}.`}</p>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1 text-sm font-semibold text-stone-900">Employment information<HelpTip title="Employment information">Set by HR from your official employment record — the same record your manager, payroll and reports use. You can&apos;t change it here; if anything is wrong, request a correction and HR will review it.</HelpTip></h2>
            <p className="text-xs text-stone-500">🔒 Managed by HR.</p>
          </div>
          <RequestCorrectionButton />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          {employment.map(([label, value]) => (
            <div key={label}><dt className="text-xs uppercase text-stone-400">{label}</dt><Locked>{value}</Locked></div>
          ))}
        </dl>
      </section>

      <section className="card">
        <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-stone-900">Personal &amp; contact information<HelpTip title="Why we hold this">Used by authorized HR personnel to contact you about your employment. It isn&apos;t shown in the employee directory, and your supervisor or manager can&apos;t see it.</HelpTip></h2>
        <p className="mb-4 text-xs text-stone-500">Visible only to you and authorized HR staff.</p>
        {!canEdit && <p className="alert-warning mb-4">Your role doesn&apos;t include editing your own profile. Ask HR to update anything that has changed.</p>}

        {canEdit && (
          <div className="mb-5 border-b border-stone-100 pb-5">
            <ProfileForm employeeId={employee.id} workPhoneEditable={record.settings.work_phone_editable} initial={{ preferred_name: employee.preferred_name, work_phone: record.work_phone }} />
          </div>
        )}

        <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3 border-b border-stone-100 pb-5 text-sm">
          <div>
            <dt className="text-xs uppercase text-stone-400">Date of birth</dt>
            <Locked>{dob ? formatDate(`${dob}T12:00:00Z`, "UTC", { dateStyle: "long" }) : "Not on file"}</Locked>
            <div className="mt-1"><RequestCorrectionButton compact defaultField="date_of_birth" label="Request correction" /></div>
          </div>
          {!canEdit && (
            <div><dt className="text-xs uppercase text-stone-400">Work phone</dt><Locked>{formatPhone(record.work_phone) || "—"}</Locked></div>
          )}
        </dl>

        {canEdit && (
          <EmployeePersonalInfoForm
            mode="self"
            organizationId={employee.organization_id}
            employeeId={employee.id}
            initial={privateInfo}
            collectGender={record.settings.collect_gender}
            collectMaritalStatus={record.settings.collect_marital_status}
          />
        )}
      </section>

      <section className="card">
        <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-stone-900">Government &amp; compliance IDs<HelpTip title="Why we hold this">Used by authorized HR personnel for statutory, payroll and employment administration where it applies. Numbers are shown masked.</HelpTip></h2>
        <p className="mb-4 text-xs text-stone-500">🔒 Recorded and verified by HR.</p>
        {(identifiers ?? []).length === 0 ? (
          <p className="text-sm text-stone-500">No government IDs are currently recorded on your employee file. Contact HR if you believe information is missing.</p>
        ) : (
          <ul className="divide-y divide-stone-100 text-sm">
            {(identifiers ?? []).map((identifier) => (
              <li key={identifier.id} className="flex items-center justify-between py-2">
                <span>{identifierTypeLabel(identifier.identifier_type, identifier.label)} <span className="ml-2 font-mono text-xs text-stone-500">{maskIdentifier(identifier.identifier_value)}</span></span>
                {identifier.verified_at ? <span className="badge badge-emerald">Verified</span> : <span className="badge badge-neutral">Not verified</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3"><RequestCorrectionButton compact defaultField="government_id" label="Something missing or wrong? Request a correction" /></div>
      </section>

      <section className="card">
        <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-stone-900">Emergency contacts<HelpTip title="Why we hold this">Used when your organization needs to contact someone on your behalf in an emergency.</HelpTip></h2>
        <p className="mb-4 text-xs text-stone-500">Keep at least one contact up to date, with a phone number or email.</p>
        {canEdit
          ? <EmergencyContactsEditor organizationId={employee.organization_id} employeeId={employee.id} contacts={contacts ?? []} />
          : <ul className="text-sm">{(contacts ?? []).map((c) => <li key={c.id}>{c.full_name}{c.relationship ? ` (${c.relationship})` : ""}{c.is_primary ? " · primary" : ""}</li>)}</ul>}
      </section>

      <section className="card" id="my-requests">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">My requests</h2>
        <MyRecordRequests requests={myRequests} timezone={timezone} />
      </section>

      <section className="card">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-stone-900"><Icon name="shield" size={16} /> Privacy &amp; data</h2>
        <dl className="space-y-3 text-sm text-stone-700">
          <div>
            <dt className="font-medium text-stone-900">Who can see my information?</dt>
            <dd>Your name, position and work contact details may be visible to colleagues according to their role. Your personal details, government IDs and emergency contacts are restricted to you and authorized HR staff — not your supervisor or manager.</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">Privacy notice</dt>
            <dd>
              {record.settings.privacy_notice_url
                ? <a className="text-royal-700 hover:underline" href={record.settings.privacy_notice_url} target="_blank" rel="noreferrer">Read your organization&apos;s privacy notice</a>
                : "Your organization hasn't published a privacy notice in HaloManage yet — ask HR for a copy."}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">A copy of my information</dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              <DownloadMyDataButton />
              <RequestDataCopyButton hasPending={myRequests.some((r) => r.kind === "data_access" && r.status === "pending")} />
            </dd>
            <dd className="mt-1 text-xs text-stone-500">The download is instant. A formal request asks HR for everything held about you, including records you can&apos;t see here.</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-stone-500">Notification choices have moved to <Link className="text-royal-700 hover:underline" href="/settings">Settings</Link>.</p>
      </section>
    </div>
  );
}
