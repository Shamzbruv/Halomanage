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
// @deno-types="./vendor/xlsx-0.20.3.d.ts"
import * as XLSX from "./vendor/xlsx-0.20.3.mjs";
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
  currency: "currency",
  "gross pay": "gross_pay",
  "regular pay": "regular_pay",
  "overtime pay": "overtime_pay",
  allowances: "allowances",
  bonus: "bonus",
  tax: "tax",
  "other deductions": "other_deductions",
  "net pay": "net_pay",
  earnings: "earnings",
  deductions: "deductions",
  taxes: "taxes",
  "employer contributions": "employer_values",
};

const DEFAULT_COMPENSATION_MAP: Record<string, string> = {
  "employee id": "external_employee_id",
  "employee number": "employee_number",
  "effective date": "effective_date",
  "old salary": "old_amount",
  "new salary": "new_amount",
  currency: "currency",
};

import { stageRow, validateHeaders } from "./parser.mjs";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return jsonResponse({ error: "POST required" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!,
    key = Deno.env.get("SUPABASE_ANON_KEY")!,
    serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authorization = req.headers.get("Authorization");
  if (!authorization)
    return jsonResponse({ error: "Authorization required" }, 401);
  const caller = createClient(url, key, {
      global: { headers: { Authorization: authorization } },
    }),
    admin = createClient(url, serviceKey);
  let claimedId: string | null = null;
  try {
    const { batch_id } = await req.json();
    if (typeof batch_id !== "string" || !/^[-0-9a-f]{36}$/i.test(batch_id))
      return jsonResponse({ error: "Valid batch_id required" }, 400);
    // Atomic claim checks importer permission and step-up authentication. Read access
    // to an approved batch never authorizes processing or a service-role write.
    const { data: batch, error: claimError } = await caller.rpc(
      "claim_payroll_processing",
      { p_batch_id: batch_id },
    );
    if (claimError || !batch)
      return jsonResponse(
        { error: claimError?.message ?? "Not authorized" },
        409,
      );
    claimedId = batch.id;
    const { data: file, error: downloadError } = await admin.storage
      .from("payroll-imports")
      .download(batch.original_file_path);
    if (downloadError || !file)
      throw new Error(
        "Could not read the uploaded file. Reject this batch and upload again.",
      );
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Import exceeds the 10 MB limit");
    const buffer = new Uint8Array(await file.arrayBuffer());
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== batch.file_hash)
      throw new Error("Uploaded file fingerprint does not match the batch");
    const workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true,
      sheetRows: 10002,
      raw: true,
    });
    if (workbook.SheetNames.length !== 1)
      throw new Error("Use a file with exactly one worksheet");
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
      defval: null,
    });
    if (!rows.length || rows.length > 10000)
      throw new Error("Import must contain 1–10,000 data rows");
    let columnMap: Record<string, string> =
      batch.batch_type === "compensation_change"
        ? DEFAULT_COMPENSATION_MAP
        : DEFAULT_PAY_RUN_MAP;
    if (batch.column_map_id) {
      const { data: map, error } = await admin
        .from("payroll_column_maps")
        .select("mapping")
        .eq("id", batch.column_map_id)
        .eq("organization_id", batch.organization_id)
        .single();
      if (error) throw error;
      columnMap = map.mapping;
    }
    columnMap = Object.fromEntries(
      Object.entries(columnMap).map(([key, value]) => [
        key.trim().toLowerCase(),
        value,
      ]),
    );
    const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    });
    validateHeaders(headerRows[0] ?? [], columnMap);
    const employees: {
      id: string;
      employee_number: string;
      external_payroll_id: string | null;
    }[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await admin
        .from("employees")
        .select("id,employee_number,external_payroll_id")
        .eq("organization_id", batch.organization_id)
        .order("id")
        .range(start, start + 999);
      if (error) throw error;
      employees.push(...(data ?? []));
      if ((data?.length ?? 0) < 1000) break;
      if (start >= 99000)
        throw new Error(
          "Employee matching exceeds this import's supported size",
        );
    }
    const staged = rows.map((raw, i) => {
      const mapped: Record<string, unknown> = Object.create(null);
      for (const [header, value] of Object.entries(raw)) {
        const target = columnMap[header.trim().toLowerCase()];
        if (target) {
          if (target in mapped)
            throw new Error(`Multiple columns map to ${target}`);
          mapped[target] = value;
        }
      }
      return stageRow(mapped, raw, batch, employees ?? [], i + 1);
    });
    const table =
      batch.batch_type === "compensation_change"
        ? "compensation_change_rows"
        : "payroll_import_rows";
    // A single atomic insert prevents half-staged imports. Database validation is
    // authoritative and is repeated under lock when HR publishes the batch.
    const { error: insertError } = await admin.from(table).insert(staged);
    if (insertError) throw insertError;
    const { data: recomputed, error: validationError } = await caller.rpc(
      "recompute_payroll_batch_status",
      { p_batch_id: batch.id },
    );
    if (validationError) throw validationError;
    return jsonResponse({
      ok: true,
      batch: recomputed,
      rows_staged: staged.length,
    });
  } catch (err) {
    if (claimedId)
      await admin
        .from("payroll_import_batches")
        .update({ status: "needs_review" })
        .eq("id", claimedId)
        .eq("status", "processing");
    console.error("Payroll import failed", { batch_id: claimedId });
    return jsonResponse(
      {
        error:
          err instanceof Error
            ? err.message
            : "Payroll processing failed. Reject the batch and upload a corrected file.",
      },
      400,
    );
  }
});
