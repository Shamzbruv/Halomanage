import Link from "next/link";
import { redirect } from "next/navigation";
import { EmployeeRecordSettingsForm } from "@/components/EmployeeRecordSettingsForm";
import { RequestProfileConfirmationButton } from "@/components/RequestProfileConfirmationButton";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function EmployeeRecordSettingsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: numbering }, { data: requirements }] = await Promise.all([
    supabase.from("organization_employee_number_settings").select("*").eq("organization_id", session.organizationId).maybeSingle(),
    supabase.from("employee_setup_preferences").select("*").eq("organization_id", session.organizationId).maybeSingle(),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/admin/employees" className="text-xs text-royal-700 hover:text-royal-800">← People</Link>
        <div className="page-intro mt-2"><span className="eyebrow">People settings</span><h1>How employee records are numbered and completed.</h1><p>These rules apply to everyone HR adds from now on.</p></div>
      </div>
      <EmployeeRecordSettingsForm
        organizationId={session.organizationId}
        numbering={{
          mode: numbering?.mode ?? "automatic",
          prefix: numbering?.prefix ?? "EMP-",
          padding: numbering?.padding ?? 4,
          next_sequence: Number(numbering?.next_sequence ?? 1),
          allow_manual_override: numbering?.allow_manual_override ?? true,
        }}
        requirements={{
          require_reporting_line: requirements?.require_reporting_line ?? true,
          require_onboarding_plan: requirements?.require_onboarding_plan ?? true,
          require_date_of_birth: requirements?.require_date_of_birth ?? false,
          require_trn: requirements?.require_trn ?? false,
          require_personal_email: requirements?.require_personal_email ?? false,
          require_personal_phone: requirements?.require_personal_phone ?? false,
          require_home_address: requirements?.require_home_address ?? false,
          require_emergency_contact: requirements?.require_emergency_contact ?? false,
        }}
        profile={{
          collect_gender: requirements?.collect_gender ?? "off",
          collect_marital_status: requirements?.collect_marital_status ?? "off",
          work_phone_editable_by_employee: requirements?.work_phone_editable_by_employee ?? false,
          privacy_notice_url: requirements?.privacy_notice_url ?? "",
        }}
      />
      <section className="card space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Employee information check</h2>
          <p className="text-xs text-stone-500">Ask every active employee to review My Profile and confirm their details are still correct — for example once a year. Each person&apos;s last confirmation date appears in People.</p>
        </div>
        <RequestProfileConfirmationButton organizationId={session.organizationId} />
      </section>
    </div>
  );
}
