"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const supabase = createClient();
  const router = useRouter();

  return (
    <button
      className={compact ? "account-signout" : "btn-ghost"}
      aria-label={compact ? "Sign out" : undefined}
      onClick={async () => {
        await supabase.auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      {compact ? <Icon name="logout" size={18} /> : "Sign out"}
    </button>
  );
}
