"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

// "Sign out" means this device only (scope: "local"). supabase-js defaults
// to a *global* sign-out, which would also end every other browser and
// phone the person is signed in on — not what the button says. Signing out
// other devices, or everywhere, is offered explicitly in Settings.
export function SignOutButton({ compact = false, className }: { compact?: boolean; className?: string }) {
  const supabase = createClient();
  const router = useRouter();

  return (
    <button
      className={className ?? (compact ? "account-signout" : "btn-ghost")}
      aria-label={compact ? "Sign out of this device" : undefined}
      title="Sign out of this device"
      onClick={async () => {
        await supabase.auth.signOut({ scope: "local" });
        router.push("/login");
        router.refresh();
      }}
    >
      {compact ? <Icon name="logout" size={18} /> : "Sign out"}
    </button>
  );
}
