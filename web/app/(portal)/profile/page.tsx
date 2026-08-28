import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { ProfileForm } from "@/components/ProfileForm";
import { PrivateInfoForm } from "@/components/PrivateInfoForm";
import { AvatarUpload } from "@/components/AvatarUpload";

export default async function ProfilePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const { data: privateInfo } = await supabase
    .from("employee_private")
    .select("*")
    .eq("employee_id", session.employee.id)
    .maybeSingle();

  const avatarResult = session.employee.avatar_url
    ? await supabase.storage.from("employee-avatars").createSignedUrl(session.employee.avatar_url, 3600)
    : null;
  const employeeName = `${session.employee.preferred_name || session.employee.first_name} ${session.employee.last_name}`;

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
        <PrivateInfoForm organizationId={session.organizationId!} employeeId={session.employee.id} initial={privateInfo ?? {}} />
      </div>
    </div>
  );
}
