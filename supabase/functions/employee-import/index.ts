// Halomanage — employee Migration Center parser
//
// Parses a private CSV/XLS/XLSX workbook, normalizes mapped columns, and
// stages inert rows for database validation. It never writes to employees;
// commit_employee_import_batch() is the only posting boundary.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import * as XLSX from "npm:xlsx@0.18.5";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

type SourceSystem = "spreadsheet" | "orangehrm" | "bamboohr" | "zoho_people" | "other";

const TARGET_FIELDS = new Set([
  "employee_number",
  "external_payroll_id",
  "first_name",
  "last_name",
  "preferred_name",
  "work_email",
  "work_phone",
  "status",
  "hire_date",
  "probation_end_date",
]);

const COMMON_MAP: Record<string, string> = {
  "employee number": "employee_number",
  "employee no": "employee_number",
  "employee #": "employee_number",
  "employee id": "employee_number",
  "staff id": "employee_number",
  "external payroll id": "external_payroll_id",
  "payroll id": "external_payroll_id",
  "first name": "first_name",
  "firstname": "first_name",
  "last name": "last_name",
  "surname": "last_name",
  "lastname": "last_name",
  "preferred name": "preferred_name",
  "known as": "preferred_name",
  "work email": "work_email",
  "company email": "work_email",
  "email": "work_email",
  "work phone": "work_phone",
  "mobile phone": "work_phone",
  "phone": "work_phone",
  "employment status": "status",
  "employee status": "status",
  "status": "status",
  "hire date": "hire_date",
  "hired date": "hire_date",
  "joined date": "hire_date",
  "date joined": "hire_date",
  "probation end date": "probation_end_date",
};

const SOURCE_MAPS: Record<SourceSystem, Record<string, string>> = {
  spreadsheet: COMMON_MAP,
  orangehrm: {
    ...COMMON_MAP,
    "emp. number": "employee_number",
    "employee id": "employee_number",
    "joined date": "hire_date",
  },
  bamboohr: {
    ...COMMON_MAP,
    "eeid": "employee_number",
    "best email": "work_email",
    "hiredate": "hire_date",
  },
  zoho_people: {
    ...COMMON_MAP,
    "employee id": "employee_number",
    "date of joining": "hire_date",
    "email id": "work_email",
  },
  other: COMMON_MAP,
};

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function textValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function dateValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function statusValue(value: unknown) {
  const status = textValue(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!status) return null;
  if (["enabled", "current", "employed", "permanent"].includes(status)) return "active";
  if (["inactive", "separated", "resigned", "former"].includes(status)) return "terminated";
  if (["new_hire", "pending", "pending_hire"].includes(status)) return "prehire";
  if (["on_leave", "leave_of_absence"].includes(status)) return "leave";
  return status;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  let batchId: string | null = null;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await req.json();
    batchId = typeof body?.batch_id === "string" ? body.batch_id : null;
    if (!batchId) return jsonResponse({ error: "batch_id is required" }, 400);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // RLS proves the caller holds employee.manage in this organization.
    const { data: batch, error: batchError } = await callerClient
      .from("employee_import_batches")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) return jsonResponse({ error: "Not authorized to process this import" }, 403);
    if (["committed", "rolled_back"].includes(batch.status)) {
      return jsonResponse({ error: "A completed import cannot be processed again" }, 409);
    }

    await adminClient
      .from("employee_import_batches")
      .update({ status: "processing", error_message: null })
      .eq("id", batchId);

    const { data: fileBlob, error: downloadError } = await adminClient.storage
      .from("employee-imports")
      .download(batch.original_file_path);

    if (downloadError || !fileBlob) throw new Error(`Could not read uploaded file: ${downloadError?.message ?? "unknown error"}`);

    const buffer = new Uint8Array(await fileBlob.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new Error("The workbook does not contain a worksheet");
    const sheet = workbook.Sheets[firstSheetName];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
    if (rows.length > 10_000) throw new Error("Imports are limited to 10,000 rows per workbook");

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const preset = SOURCE_MAPS[(batch.source_system as SourceSystem) ?? "spreadsheet"] ?? COMMON_MAP;
    const configured = batch.column_mapping && typeof batch.column_mapping === "object"
      ? batch.column_mapping as Record<string, unknown>
      : {};

    const mapping = new Map<string, string>();
    for (const header of headers) {
      const normalized = normalizeHeader(header);
      const configuredTarget = Object.entries(configured)
        .find(([source]) => normalizeHeader(source) === normalized)?.[1];
      const target = typeof configuredTarget === "string" && TARGET_FIELDS.has(configuredTarget)
        ? configuredTarget
        : preset[normalized];
      if (target && TARGET_FIELDS.has(target)) mapping.set(normalized, target);
    }

    const effectiveMapping = Object.fromEntries(
      headers
        .map((header) => [header, mapping.get(normalizeHeader(header))] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    );

    const staged: Array<Record<string, unknown>> = [];
    rows.forEach((raw, index) => {
      const normalized: Record<string, unknown> = {};
      for (const [header, value] of Object.entries(raw)) {
        const target = mapping.get(normalizeHeader(header));
        if (!target) continue;
        if (target === "hire_date" || target === "probation_end_date") normalized[target] = dateValue(value);
        else if (target === "status") normalized[target] = statusValue(value);
        else normalized[target] = textValue(value);
      }

      // Preserve a genuinely empty row neither as an error nor as a phantom employee.
      if (Object.values(raw).every((value) => textValue(value) === null)) return;
      staged.push({ batch_id: batchId, row_number: index + 2, raw_row: raw, normalized_row: normalized });
    });

    const { error: deleteError } = await adminClient
      .from("employee_import_rows")
      .delete()
      .eq("batch_id", batchId);
    if (deleteError) throw new Error(`Could not reset staged rows: ${deleteError.message}`);

    for (let offset = 0; offset < staged.length; offset += 500) {
      const { error: insertError } = await adminClient
        .from("employee_import_rows")
        .insert(staged.slice(offset, offset + 500));
      if (insertError) throw new Error(`Could not stage rows: ${insertError.message}`);
    }

    const { error: batchUpdateError } = await adminClient
      .from("employee_import_batches")
      .update({
        source_headers: headers,
        column_mapping: effectiveMapping,
        status: "needs_review",
        error_message: null,
      })
      .eq("id", batchId);
    if (batchUpdateError) throw new Error(`Could not save detected columns: ${batchUpdateError.message}`);

    const { data: validated, error: validationError } = await callerClient
      .rpc("revalidate_employee_import_batch", { p_batch_id: batchId });
    if (validationError) throw new Error(`Validation failed: ${validationError.message}`);

    return jsonResponse({ ok: true, batch: validated, rows_staged: staged.length, headers, mapping: effectiveMapping });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected import error";
    if (batchId) {
      await adminClient
        .from("employee_import_batches")
        .update({ status: "failed", error_message: message.slice(0, 1000) })
        .eq("id", batchId);
    }
    return jsonResponse({ error: message }, 500);
  }
});
