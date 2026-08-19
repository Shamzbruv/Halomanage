import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { ProfileForm } from "@/components/ProfileForm";
import { PrivateInfoForm } from "@/components/PrivateInfoForm";

export default async function ProfilePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) return null;

  const supabase = await createClient();
  const { data: privateInfo } = await supabase
    .from("employee_private")
    .select("*")
    .eq("employee_id", session.employee.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-stone-900">My profile</h1>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Basic details</h2>
        <p className="mb-4 text-xs text-stone-500">
          {session.employee.first_name} {session.employee.last_name} · {session.employee.employee_number} · {session.employee.work_email}
        </p>
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
