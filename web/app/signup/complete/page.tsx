import { redirect } from "next/navigation";
import { CompleteWorkspaceSetup } from "@/components/CompleteWorkspaceSetup";
import { getCurrentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function CompleteSignupPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.employee || session.roles.length > 0) redirect("/dashboard");
  return <CompleteWorkspaceSetup />;
}
