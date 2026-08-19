"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Ref: 20260818000400_authorization.sql "employees_protect_columns" — this
// form only ever touches preferred_name/work_phone/avatar_url, the exact
// columns that trigger allows a non-HR self-update to change. Anything
// else (status, hire_date, employee_number...) is blocked at the database
// regardless of what a client sends.
export function ProfileForm({
  employeeId,
  initial,
}: {
  employeeId: string;
  initial: { preferred_name: string | null; work_phone: string | null };
}) {
  const supabase = createClient();
  const router = useRouter();
  const [preferredName, setPreferredName] = useState(initial.preferred_name ?? "");
  const [workPhone, setWorkPhone] = useState(initial.work_phone ?? "");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    const { error } = await supabase
      .from("employees")
      .update({ preferred_name: preferredName || null, work_phone: workPhone || null })
      .eq("id", employeeId);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label">Preferred name</label>
        <input className="input" value={preferredName} onChange={(e) => setPreferredName(e.target.value)} />
      </div>
      <div>
        <label className="label">Work phone</label>
        <input className="input" value={workPhone} onChange={(e) => setWorkPhone(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
