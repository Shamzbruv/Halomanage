"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatPhone } from "@/lib/phone";

export type EmergencyContact = {
  id: string;
  full_name: string;
  relationship: string | null;
  phone: string | null;
  alternate_phone: string | null;
  email: string | null;
  is_primary: boolean;
};

const blank = { full_name: "", relationship: "", phone: "", alternate_phone: "", email: "" };

// employee_emergency_contacts is editable by the employee themself and by
// HR (employee.manage). One contact may be primary — enforced by a partial
// unique index, so switching primary clears the old one first.
export function EmergencyContactsEditor({
  organizationId,
  employeeId,
  contacts,
}: {
  organizationId: string;
  employeeId: string;
  contacts: EmergencyContact[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startEdit(contact: EmergencyContact) {
    setEditingId(contact.id);
    setForm({
      full_name: contact.full_name,
      relationship: contact.relationship ?? "",
      phone: formatPhone(contact.phone),
      alternate_phone: formatPhone(contact.alternate_phone),
      email: contact.email ?? "",
    });
  }

  function reset() {
    setEditingId(null);
    setForm(blank);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.phone.trim() && !form.alternate_phone.trim() && !form.email.trim()) {
      setError("Add at least one way to reach this person — a phone number or an email.");
      return;
    }
    setLoading(true);
    setError(null);
    const values = {
      full_name: form.full_name.trim(),
      relationship: form.relationship.trim() || null,
      phone: form.phone.trim() || null,
      alternate_phone: form.alternate_phone.trim() || null,
      email: form.email.trim() || null,
    };
    const { error: saveError } = editingId
      ? await supabase.from("employee_emergency_contacts").update(values).eq("id", editingId)
      : await supabase.from("employee_emergency_contacts").insert({
          ...values,
          organization_id: organizationId,
          employee_id: employeeId,
          // The first contact is primary automatically.
          is_primary: contacts.length === 0,
        });
    if (saveError) {
      setError(saveError.message);
      setLoading(false);
      return;
    }
    reset();
    setLoading(false);
    router.refresh();
  }

  async function makePrimary(contact: EmergencyContact) {
    setBusyId(contact.id);
    setError(null);
    // One database transaction (set_primary_emergency_contact), so there's
    // never a moment with no primary contact if something fails midway.
    const { error: rpcError } = await supabase.rpc("set_primary_emergency_contact", { p_contact_id: contact.id });
    if (rpcError) setError(rpcError.message);
    setBusyId(null);
    router.refresh();
  }

  async function remove(contact: EmergencyContact) {
    if (!window.confirm(`Remove ${contact.full_name} as an emergency contact?`)) return;
    setBusyId(contact.id);
    setError(null);
    const { error: deleteError } = await supabase.from("employee_emergency_contacts").delete().eq("id", contact.id);
    if (deleteError) setError(deleteError.message);
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="space-y-4" id="emergency_contact">
      <ul className="divide-y divide-stone-100">
        {contacts.length === 0 && <li className="py-2 text-sm text-stone-400">No emergency contacts yet.</li>}
        {contacts.map((contact) => (
          <li key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <div>
              <p className="font-medium text-stone-900">
                {contact.full_name}
                {contact.relationship && <span className="ml-2 text-xs font-normal text-stone-500">{contact.relationship}</span>}
              </p>
              <p className="text-xs text-stone-500">
                {[formatPhone(contact.phone), formatPhone(contact.alternate_phone), contact.email].filter(Boolean).join(" · ") || <span className="text-amber-700">No way to reach them — add a phone or email</span>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {contact.is_primary
                ? <span className="badge badge-emerald">Primary</span>
                : <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === contact.id} onClick={() => makePrimary(contact)}>Make primary</button>}
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => startEdit(contact)}>Edit</button>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === contact.id} onClick={() => remove(contact)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={handleSubmit} className="rounded-xl border border-stone-100 p-3">
        <h4 className="mb-2 text-xs font-semibold uppercase text-stone-400">{editingId ? "Edit contact" : "Add a contact"}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="contact-name">Full name</label>
            <input id="contact-name" required className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="contact-relationship">Relationship</label>
            <input id="contact-relationship" className="input" placeholder="e.g. Mother, Spouse" value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="contact-phone">Phone</label>
            <input id="contact-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="contact-alt-phone">Alternate phone</label>
            <input id="contact-alt-phone" className="input" value={form.alternate_phone} onChange={(e) => setForm({ ...form, alternate_phone: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="contact-email">Email</label>
            <input id="contact-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        </div>
        {error && <p role="alert" className="alert-error mt-3">{error}</p>}
        <div className="mt-3 flex gap-2">
          <button type="submit" disabled={loading || !form.full_name.trim()} className="btn-primary">{loading ? "Saving…" : editingId ? "Save changes" : "Add contact"}</button>
          {editingId && <button type="button" className="btn-secondary" onClick={reset}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}
