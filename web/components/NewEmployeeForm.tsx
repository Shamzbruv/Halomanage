"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function NewEmployeeForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employee_number: "",
    first_name: "",
    last_name: "",
    work_email: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("employees").insert({
      organization_id: organizationId,
      employee_number: form.employee_number,
      first_name: form.first_name,
      last_name: form.last_name,
      work_email: form.work_email || null,
      status: "prehire",
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setForm({ employee_number: "", first_name: "", last_name: "", work_email: "" });
    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>
        New employee
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card w-full max-w-md space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">New employee</h3>
      <div className="grid grid-cols-2 gap-3">
        <input
          required
          placeholder="Employee number"
          className="input"
          value={form.employee_number}
          onChange={(e) => setForm({ ...form, employee_number: e.target.value })}
        />
        <input
          required
          placeholder="Work email"
          type="email"
          className="input"
          value={form.work_email}
          onChange={(e) => setForm({ ...form, work_email: e.target.value })}
        />
        <input
          required
          placeholder="First name"
          className="input"
          value={form.first_name}
          onChange={(e) => setForm({ ...form, first_name: e.target.value })}
        />
        <input
          required
          placeholder="Last name"
          className="input"
          value={form.last_name}
          onChange={(e) => setForm({ ...form, last_name: e.target.value })}
        />
      </div>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? "Saving…" : "Create"}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-slate-400">
        Creates the HR record only (status: prehire). Set their department/position/supervisor from
        the employee detail page, then use &quot;Invite&quot; to create their login.
      </p>
    </form>
  );
}
