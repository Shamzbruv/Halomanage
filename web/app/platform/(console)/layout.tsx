import { redirect } from "next/navigation";
import { getPlatformSession } from "@/lib/platform-session";
import { PlatformShell } from "@/components/platform/PlatformShell";

// The one gate every /platform/* page (other than /platform/login itself,
// which sits outside this route group) passes through. Deliberately does
// not import lib/session.ts — a tenant admin, however powerful inside
// their own organization, has no path to platform_staff membership and
// gets redirected exactly like anyone else who isn't platform staff.
export default async function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await getPlatformSession();
  if (!session) redirect("/platform/login");

  return (
    <PlatformShell email={session.email} role={session.role}>
      {children}
    </PlatformShell>
  );
}
