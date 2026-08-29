"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function ToggleProviderActiveButton({ providerId, isActive }: { providerId: string; isActive: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    await supabase.from("reward_providers").update({ is_active: !isActive }).eq("id", providerId);
    setLoading(false);
    router.refresh();
  }

  return (
    <button type="button" className="platform-btn platform-btn-secondary" disabled={loading} onClick={() => void toggle()}>
      {loading ? "…" : isActive ? "Deactivate" : "Activate"}
    </button>
  );
}
