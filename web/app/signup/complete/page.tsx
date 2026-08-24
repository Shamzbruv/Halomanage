import { redirect } from "next/navigation";
import { CompleteWorkspaceSetup } from "@/components/CompleteWorkspaceSetup";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function CompleteSignupPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.employee && session.roles.length > 0 && session.organization) redirect("/dashboard");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const metadata = user?.user_metadata ?? {};

  return <CompleteWorkspaceSetup initial={{
    organizationName: typeof metadata.organization_name === "string" ? metadata.organization_name : "",
    organizationSlug: typeof metadata.organization_slug === "string" ? metadata.organization_slug : "",
    firstName: typeof metadata.first_name === "string" ? metadata.first_name : "",
    lastName: typeof metadata.last_name === "string" ? metadata.last_name : "",
    timezone: typeof metadata.timezone === "string" ? metadata.timezone : "UTC",
    countryCode: typeof metadata.country_code === "string" ? metadata.country_code : "",
  }} />;
}
