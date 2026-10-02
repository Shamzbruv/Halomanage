"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatPhone } from "@/lib/phone";

// The employee's own directory details. The database decides what a
// self-update may change (private.enforce_employee_protected_columns):
// preferred name always (with employee.update_self), work phone only when
// the organization lets employees manage it — otherwise it's HR/IT data
// that other people rely on, shown here read-only.
export function ProfileForm({
  employeeId,
  initial,
  workPhoneEditable,
}: {
  employeeId: string;
  initial: { preferred_name: string | null; work_phone: string | null };
  workPhoneEditable: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [preferredName, setPreferredName] = useState(initial.preferred_name ?? "");
  const [workPhone, setWorkPhone] = useState(formatPhone(initial.work_phone));
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    const update: Record<string, string | null> = { preferred_name: preferredName.trim() || null };
    if (workPhoneEditable) update.work_phone = workPhone.trim() || null;
    const { error } = await supabase.from("employees").update(update).eq("id", employeeId);
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="preferred-name">Preferred name</label>
          <input id="preferred-name" className="input" value={preferredName} onChange={(e) => setPreferredName(e.target.value)} />
          <p className="field-help">What colleagues see — your legal name stays on your official record.</p>
        </div>
        <div>
          <label className="label" htmlFor="work-phone">Work phone</label>
          {workPhoneEditable ? (
            <input id="work-phone" type="tel" className="input" value={workPhone} onChange={(e) => setWorkPhone(e.target.value)} />
          ) : (
            <p id="work-phone" className="input bg-stone-50 text-stone-600">🔒 {formatPhone(initial.work_phone) || "Not set"}</p>
          )}
          {!workPhoneEditable && <p className="field-help">Managed by HR/IT — request a correction if it&apos;s wrong.</p>}
        </div>
      </div>
      {error && <p className="alert-error">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
