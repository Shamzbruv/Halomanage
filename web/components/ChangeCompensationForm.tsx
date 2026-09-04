"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

const PAY_TYPES = [
  { value: "salaried", label: "Salaried" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily rate" },
  { value: "weekly_rated", label: "Weekly rate" },
  { value: "monthly_rated", label: "Monthly rate" },
  { value: "piece_rate", label: "Piece rate" },
  { value: "commission", label: "Commission" },
  { value: "contract_fixed_fee", label: "Contract / fixed fee" },
  { value: "other", label: "Other" },
];
const RATE_UNITS = ["hour", "day", "week", "month", "year", "piece", "contract"];
const PAY_FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual", "custom"];

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export type PayGroupOption = { id: string; name: string };
export type PayGradeOption = { id: string; name: string };
export type ChangeReasonOption = { id: string; name: string };

// Ref: supabase/migrations/20260829110000_compensation_pay_administration.sql
// — change_employee_compensation() closes the previous open effective-dated
// row and opens a new one in the same transaction; this form is only the
// UI in front of it. Every invariant (non-negative amount, valid pay
// type/rate unit/frequency, effective date after the current record's
// start) is enforced server-side regardless of what this form sends.
export function ChangeCompensationForm({
  employeeId,
  payGroups,
  payGrades,
  reasons,
}: {
  employeeId: string;
  payGroups: PayGroupOption[];
  payGrades: PayGradeOption[];
  reasons: ChangeReasonOption[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [payType, setPayType] = useState("salaried");
  const [payTypeOtherLabel, setPayTypeOtherLabel] = useState("");
  const [rateUnit, setRateUnit] = useState("year");
  const [payFrequency, setPayFrequency] = useState("monthly");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [payGroupId, setPayGroupId] = useState("");
  const [payGradeId, setPayGradeId] = useState("");
  const [standardWeeklyHours, setStandardWeeklyHours] = useState("40");
  const [fte, setFte] = useState("1.0");
  const [overtimeEligible, setOvertimeEligible] = useState(false);
  const [reasonId, setReasonId] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("change_employee_compensation", {
      p_employee_id: employeeId,
      p_amount: Number(amount),
      p_pay_type: payType,
      p_effective_date: effectiveDate,
      p_currency: currency,
      p_rate_unit: rateUnit || null,
      p_pay_frequency: payFrequency || null,
      p_reason_id: reasonId || null,
      p_notes: notes.trim() || null,
      p_pay_group_id: payGroupId || null,
      p_pay_grade_id: payGradeId || null,
      p_standard_weekly_hours: standardWeeklyHours ? Number(standardWeeklyHours) : null,
      p_fte: fte ? Number(fte) : null,
      p_overtime_eligible: overtimeEligible,
      p_pay_type_other_label: payType === "other" ? payTypeOtherLabel.trim() || null : null,
    });

    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not change compensation."));
      setLoading(false);
      return;
    }

    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>
        <Icon name="payroll" size={14} /> Change compensation
      </button>

      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="change-compensation-title">
          <button type="button" className="modal-backdrop" aria-label="Cancel" onClick={() => !loading && setOpen(false)} />
          <div className="modal-card" style={{ maxWidth: 560 }}>
            <h2 id="change-compensation-title" className="text-base font-semibold text-stone-900">Change compensation</h2>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              Closes the current compensation record and opens a new one from the effective date you choose — history is
              preserved, never overwritten. Halomanage does not calculate tax or net pay; enter the gross rate your
              external payroll system will apply.
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="cc-pay-type">Pay type</label>
                <select id="cc-pay-type" className="input" value={payType} onChange={(event) => setPayType(event.target.value)}>
                  {PAY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {payType === "other" && (
                <div>
                  <label className="label" htmlFor="cc-pay-type-other">Describe pay type</label>
                  <input id="cc-pay-type-other" className="input" value={payTypeOtherLabel} onChange={(event) => setPayTypeOtherLabel(event.target.value)} />
                </div>
              )}
              <div>
                <label className="label" htmlFor="cc-amount">Rate amount</label>
                <input id="cc-amount" type="number" min="0" step="0.01" required className="input" value={amount} onChange={(event) => setAmount(event.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="cc-currency">Currency</label>
                <input id="cc-currency" className="input" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} />
              </div>
              <div>
                <label className="label" htmlFor="cc-rate-unit">Rate unit</label>
                <select id="cc-rate-unit" className="input" value={rateUnit} onChange={(event) => setRateUnit(event.target.value)}>
                  {RATE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cc-frequency">Pay frequency</label>
                <select id="cc-frequency" className="input" value={payFrequency} onChange={(event) => setPayFrequency(event.target.value)}>
                  {PAY_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cc-effective-date">Effective date</label>
                <input id="cc-effective-date" type="date" required className="input" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="cc-pay-group">Pay group</label>
                <select id="cc-pay-group" className="input" value={payGroupId} onChange={(event) => setPayGroupId(event.target.value)}>
                  <option value="">Not set</option>
                  {payGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <p className="field-help">Connects this person to a pay calendar — leaving it unset means their My Pay page can never show a next pay date, even once one exists.</p>
              </div>
              <div>
                <label className="label" htmlFor="cc-pay-grade">Pay grade</label>
                <select id="cc-pay-grade" className="input" value={payGradeId} onChange={(event) => setPayGradeId(event.target.value)}>
                  <option value="">Not set</option>
                  {payGrades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cc-hours">Standard weekly hours</label>
                <input id="cc-hours" type="number" min="0" step="0.5" className="input" value={standardWeeklyHours} onChange={(event) => setStandardWeeklyHours(event.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="cc-fte">FTE</label>
                <input id="cc-fte" type="number" min="0" max="2" step="0.01" className="input" value={fte} onChange={(event) => setFte(event.target.value)} />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <input id="cc-overtime" type="checkbox" checked={overtimeEligible} onChange={(event) => setOvertimeEligible(event.target.checked)} />
                <label htmlFor="cc-overtime" className="text-sm text-stone-700">Eligible for overtime</label>
              </div>
              <div>
                <label className="label" htmlFor="cc-reason">Reason</label>
                <select id="cc-reason" className="input" value={reasonId} onChange={(event) => setReasonId(event.target.value)}>
                  <option value="">Not specified</option>
                  {reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="cc-notes">Notes <span className="font-normal text-stone-500">(internal only)</span></label>
                <textarea id="cc-notes" className="input" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </div>
            </div>

            {error && <p className="alert-error mt-3" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={loading || !amount} onClick={() => void handleConfirm()}>
                {loading ? "Saving…" : "Save change"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
