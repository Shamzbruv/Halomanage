// Halomanage — payroll-import Edge Function
// Ref: PRODUCT_BLUEPRINT.md "The upload process should not instantly change
// records"; ARCHITECTURE.md "Excel processing flow".
//
// This function NEVER calculates payroll. It parses a workbook someone
// already uploaded to the private `payroll-imports` bucket (via
// create_payroll_import_batch()), matches each row to an employee by
// immutable employee_number/external_payroll_id (never by name), and stages
// the results as payroll_import_rows / compensation_change_rows for human
// review. Nothing is "posted" to an employee's record here — that only
// happens when an authorized person calls approve_payroll_import() after
// reviewing the reconciliation summary.
//
// Request body: { "batch_id": "<uuid>" }
//
// Deployment note: very large workbooks may exceed the Edge Function
// runtime's memory/CPU limits (ARCHITECTURE.md flags this explicitly) — if
// that becomes a real constraint, move parsing to an external worker fed by
// Supabase Queues rather than trying to force it through this function.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import * as XLSX from "npm:xlsx@0.18.5";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

// Default header → internal field mapping used when the batch has no
// explicit payroll_column_maps row. Matches the suggested import template
// in PRODUCT_BLUEPRINT.md.
const DEFAULT_PAY_RUN_MAP: Record<string, string> = {
  "employee id": "external_employee_id",
  "employee number": "employee_number",
  "employee email": "employee_email",
  "pay period start": "pay_period_start",
  "pay period end": "pay_period_end",
  "payment date": "payment_date",
  "currency": "currency",
  "gross pay": "gross_pay",
  "regular pay": "regular_pay",
  "overtime pay": "overtime_pay",
  "allowances": "allowances",
  "bonus": "bonus",
  "tax": "tax",
  "other deductions": "other_deductions",
  "net pay": "net_pay",
};

const DEFAULT_COMPENSATION_MAP: Record<string, string> = {
  "employee id": "external_employee_id",
  "employee number": "employee_number",
  "effective date": "effective_date",
  "old salary": "old_amount",
  "new salary": "new_amount",
  "currency": "currency",
};

function normalizeHeader(h: string) {
  return h.trim().toLowerCase();
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toDateString(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  try {
    const { batch_id } = await req.json();
    if (!batch_id) return jsonResponse({ error: "batch_id is required" }, 400);

    // Caller-scoped: RLS only returns this batch if the caller holds
    // payroll.import in this organization (see 20260818001200_payroll_import.sql).
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: batch, error: batchError } = await callerClient
      .from("payroll_import_batches")
      .select("*, payroll_column_maps(mapping, batch_type)")
      .eq("id", batch_id)
      .single();

    if (batchError || !batch) {
      return jsonResponse({ error: "Not authorized to process this batch" }, 403);
    }
    if (batch.status !== "uploaded") {
      return jsonResponse({ error: `Batch is already in status '${batch.status}'` }, 409);
    }

    await callerClient
      .from("payroll_import_batches")
      .update({ status: "processing" })
      .eq("id", batch_id);

    // service_role: downloading the raw file and staging rows is a trusted
    // server-side step with no client-facing RLS path (intentionally —
    // payroll_import_rows/compensation_change_rows grant no direct
    // authenticated insert; only this function and the RPCs write them).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: fileBlob, error: downloadError } = await adminClient.storage
      .from("payroll-imports")
      .download(batch.original_file_path);

    if (downloadError || !fileBlob) {
      await adminClient.from("payroll_import_batches").update({ status: "needs_review" }).eq("id", batch_id);
      return jsonResponse({ error: `Could not read uploaded file: ${downloadError?.message}` }, 500);
    }

    const buffer = new Uint8Array(await fileBlob.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

    const columnMap: Record<string, string> = batch.payroll_column_maps?.mapping ??
      (batch.batch_type === "compensation_change" ? DEFAULT_COMPENSATION_MAP : DEFAULT_PAY_RUN_MAP);

    // Pull the organization's employees once and match in memory — cheaper
    // than one query per row, and keeps matching logic (the important
    // part: employee_number/external_payroll_id, never name) in one place.
    const { data: employees } = await adminClient
      .from("employees")
      .select("id, employee_number, external_payroll_id, work_email")
      .eq("organization_id", batch.organization_id);

    const byNumber = new Map((employees ?? []).map((e) => [e.employee_number, e.id]));
    const byExternal = new Map(
      (employees ?? []).filter((e) => e.external_payroll_id).map((e) => [e.external_payroll_id as string, e.id]),
    );
    const byEmail = new Map(
      (employees ?? []).filter((e) => e.work_email).map((e) => [(e.work_email as string).toLowerCase(), e.id]),
    );

    function matchEmployee(externalId: string | null, number: string | null, email: string | null) {
      if (externalId && byExternal.has(externalId)) return byExternal.get(externalId)!;
      if (number && byNumber.has(number)) return byNumber.get(number)!;
      if (email && byEmail.has(email.toLowerCase())) return byEmail.get(email.toLowerCase())!;
      return null;
    }

    let rowNumber = 0;
    const staged: Record<string, unknown>[] = [];

    for (const raw of rows) {
      rowNumber += 1;
      const mapped: Record<string, unknown> = {};
      for (const [rawHeader, value] of Object.entries(raw)) {
        const target = columnMap[normalizeHeader(rawHeader)];
        if (target) mapped[target] = value;
      }

      const externalId = mapped.external_employee_id ? String(mapped.external_employee_id) : null;
      const number = mapped.employee_number ? String(mapped.employee_number) : null;
      const email = mapped.employee_email ? String(mapped.employee_email) : null;
      const employeeId = matchEmployee(externalId, number, email);

      if (batch.batch_type === "pay_run_results") {
        const netPay = toNumber(mapped.net_pay);
        const valid = employeeId !== null && netPay !== null;
        staged.push({
          batch_id,
          row_number: rowNumber,
          employee_id: employeeId,
          external_employee_id: externalId,
          employee_number: number,
          employee_email: email,
          employee_name_raw: raw["Employee Name"] ?? raw["Name"] ?? null,
          gross_pay: toNumber(mapped.gross_pay),
          regular_pay: toNumber(mapped.regular_pay),
          overtime_pay: toNumber(mapped.overtime_pay),
          allowances: toNumber(mapped.allowances),
          bonus: toNumber(mapped.bonus),
          tax: toNumber(mapped.tax),
          other_deductions: toNumber(mapped.other_deductions),
          net_pay: netPay,
          raw_row: raw,
          mapping_status: employeeId ? "matched" : "unmatched",
          validation_status: valid ? "valid" : "invalid",
          error_message: valid ? null : (employeeId ? "Missing/invalid net pay" : "No matching employee found"),
        });
      } else {
        const effectiveDate = toDateString(mapped.effective_date);
        const newAmount = toNumber(mapped.new_amount);
        const valid = employeeId !== null && effectiveDate !== null && newAmount !== null;
        staged.push({
          batch_id,
          row_number: rowNumber,
          employee_id: employeeId,
          external_employee_id: externalId,
          employee_number: number,
          effective_date: effectiveDate,
          old_amount: toNumber(mapped.old_amount),
          new_amount: newAmount,
          currency: mapped.currency ?? batch.currency,
          raw_row: raw,
          mapping_status: employeeId ? "matched" : "unmatched",
          validation_status: valid ? "valid" : "invalid",
          error_message: valid ? null : (employeeId ? "Missing/invalid effective date or new amount" : "No matching employee found"),
        });
      }
    }

    const table = batch.batch_type === "pay_run_results" ? "payroll_import_rows" : "compensation_change_rows";
    if (staged.length > 0) {
      const { error: insertError } = await adminClient.from(table).insert(staged);
      if (insertError) {
        await adminClient.from("payroll_import_batches").update({ status: "needs_review" }).eq("id", batch_id);
        return jsonResponse({ error: `Failed to stage rows: ${insertError.message}` }, 500);
      }
    }

    // Re-run under the caller's own JWT so the resulting audit_events row
    // correctly attributes the recompute to the importing user.
    const { data: recomputed, error: recomputeError } = await callerClient.rpc(
      "recompute_payroll_batch_status",
      { p_batch_id: batch_id },
    );
    if (recomputeError) {
      return jsonResponse({ error: recomputeError.message }, 500);
    }

    return jsonResponse({ ok: true, batch: recomputed, rows_staged: staged.length });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
