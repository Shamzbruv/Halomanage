import { createClient } from "@/lib/supabase/server";
import { getPlatformSession } from "@/lib/platform-session";
import { StaffRosterForm, type StaffRow } from "@/components/platform/StaffRosterForm";

export default async function PlatformStaffPage() {
  const session = await getPlatformSession();
  const supabase = await createClient();
  const { data } = await supabase.from("platform_staff").select("user_id, role, display_name, created_at").order("created_at");
  const staff = (data ?? []) as StaffRow[];

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Your team</span>
          <h1>Platform staff</h1>
        </div>
      </div>
      <div className="platform-card">
        <StaffRosterForm staff={staff} selfUserId={session?.userId ?? ""} canManage={session?.canManageStaff ?? false} />
      </div>
    </div>
  );
}
