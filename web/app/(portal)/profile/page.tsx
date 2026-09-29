import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { ProfileForm } from "@/components/ProfileForm";
import { EmergencyContactsEditor } from "@/components/EmergencyContactsEditor";
import { EmployeePersonalInfoForm } from "@/components/EmployeePersonalInfoForm";
import { identifierTypeLabel, maskIdentifier } from "@/lib/employeeSetup";
import { AvatarUpload } from "@/components/AvatarUpload";
import { NotificationPreferencesForm } from "@/components/NotificationPreferencesForm";

export default async function ProfilePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const [{ data: privateInfo }, { data: contacts }, { data: identifiers }] = await Promise.all([
    supabase.from("employee_private").select("*").eq("employee_id", session.employee.id).maybeSingle(),
    supabase.from("employee_emergency_contacts").select("id, full_name, relationship, phone, alternate_phone, email, is_primary").eq("employee_id", session.employee.id).order("is_primary", { ascending: false }).order("created_at"),
    supabase.from("employee_identifiers").select("id, identifier_type, label, identifier_value, verified_at").eq("employee_id", session.employee.id).order("identifier_type"),
  ]);

  const avatarResult = session.employee.avatar_url
    ? await supabase.storage.from("employee-avatars").createSignedUrl(session.employee.avatar_url, 3600)
    : null;
  const employeeName = `${session.employee.preferred_name || session.employee.first_name} ${session.employee.last_name}`;

  const { data: disabledPreferences } = await supabase
    .from("notification_preferences")
    .select("notification_type")
    .eq("user_id", session.userId)
    .eq("organization_id", session.organizationId!)
    .eq("channel", "in_app")
    .eq("enabled", false);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="page-intro"><span className="eyebrow">Your employee record</span><h1>Keep your details current.</h1><p>Update the information you control. Employment details stay managed by your HR team and every sensitive field remains separately protected.</p></div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Basic details</h2>
        <p className="mb-4 text-xs text-stone-500">
          {session.employee.first_name} {session.employee.last_name} · {session.employee.employee_number} · {session.employee.work_email}
        </p>
        <div className="mb-5 border-b border-stone-100 pb-5">
          <AvatarUpload
            employeeId={session.employee.id}
            organizationId={session.employee.organization_id}
            currentPath={session.employee.avatar_url}
            currentUrl={avatarResult?.data?.signedUrl ?? null}
            employeeName={employeeName}
          />
        </div>
        <ProfileForm
          employeeId={session.employee.id}
          initial={{
            preferred_name: session.employee.preferred_name,
            work_phone: session.employee.work_phone,
          }}
        />
      </div>

      <div className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Personal information</h2>
        <p className="mb-4 text-xs text-stone-500">
          Only visible to you and HR — never to your supervisor or manager by default.
        </p>
        <EmployeePersonalInfoForm mode="self" organizationId={session.organizationId!} employeeId={session.employee.id} initial={privateInfo} />
      </div>

      <div className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Emergency contacts</h2>
        <p className="mb-4 text-xs text-stone-500">Who HR should contact if something happens to you at work. Keep at least one up to date.</p>
        <EmergencyContactsEditor organizationId={session.organizationId!} employeeId={session.employee.id} contacts={contacts ?? []} />
      </div>

      {(identifiers ?? []).length > 0 && (
        <div className="card">
          <h2 className="mb-1 text-sm font-semibold text-stone-900">Government IDs on file</h2>
          <p className="mb-4 text-xs text-stone-500">Recorded and verified by HR. If something is wrong, contact HR — these can&apos;t be edited here.</p>
          <ul className="divide-y divide-stone-100 text-sm">
            {(identifiers ?? []).map((identifier) => (
              <li key={identifier.id} className="flex items-center justify-between py-2">
                <span>{identifierTypeLabel(identifier.identifier_type, identifier.label)} <span className="ml-2 font-mono text-xs text-stone-500">{maskIdentifier(identifier.identifier_value)}</span></span>
                {identifier.verified_at ? <span className="badge badge-emerald">Verified</span> : <span className="badge badge-neutral">Not verified</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Notifications</h2>
        <p className="mb-4 text-xs text-stone-500">
          Choose what shows up in your notification bell. Turning one off doesn&apos;t undo anything already sent.
        </p>
        <NotificationPreferencesForm
          userId={session.userId}
          organizationId={session.organizationId!}
          disabledTypes={(disabledPreferences ?? []).map((p) => p.notification_type)}
        />
      </div>
    </div>
  );
}
