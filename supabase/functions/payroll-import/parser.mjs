/** Strict source parsing; these helpers reconcile imports, never calculate pay. */
export function money(value) {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  const text = String(value).trim();
  if (!/^-?(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,2})?$/.test(text))
    throw new Error(
      "Amount must have at most 12 whole digits and two decimals",
    );
  const cleaned = text.replace(/,/g, "");
  if (cleaned.replace("-", "").split(".")[0].length > 12)
    throw new Error("Amount exceeds payroll precision");
  return cleaned;
}
export function date(value) {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(Date.parse(text + "T12:00:00Z")) ||
    new Date(text + "T12:00:00Z").toISOString().slice(0, 10) !== text
  )
    throw new Error("Date must be a real YYYY-MM-DD calendar date");
  return text;
}
export function matchEmployee(employees, externalId, number) {
  const candidates = [];
  let unknown = false;
  for (const [field, value] of [
    ["external_payroll_id", externalId],
    ["employee_number", number],
  ]) {
    if (!value) continue;
    const matches = employees.filter(
      (e) => String(e[field] ?? "").trim() === value,
    );
    if (matches.length !== 1) unknown = true;
    for (const e of matches) candidates.push(e.id);
  }
  const ids = [...new Set(candidates)];
  return !unknown && ids.length === 1
    ? { employeeId: ids[0], status: "matched" }
    : {
        employeeId: null,
        status: ids.length || unknown ? "ambiguous" : "unmatched",
      };
}
export function items(value) {
  if (value === null || value === undefined || value === "") return null;
  const arr = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(arr) || arr.length > 100)
    throw new Error(
      "Itemization must be an array of up to 100 labelled amounts",
    );
  return arr.map((x) => {
    if (
      !x ||
      typeof x.label !== "string" ||
      !x.label.trim() ||
      x.label.length > 120
    )
      throw new Error("Each item needs a label (1–120 characters)");
    const amount = money(x.amount);
    if (amount === null) throw new Error("Each item needs an amount");
    return {
      label: x.label.trim(),
      amount,
      ...(x.code ? { code: String(x.code).slice(0, 50) } : {}),
    };
  });
}
export function stageRow(mapped, raw, batch, employees, rowNumber) {
  const errors = [],
    safe = (field, fn) => {
      try {
        return fn(mapped[field]);
      } catch (e) {
        errors.push(`${field}: ${e.message}`);
        return null;
      }
    };
  const externalId = String(mapped.external_employee_id ?? "").trim() || null,
    number = String(mapped.employee_number ?? "").trim() || null;
  const match = matchEmployee(employees, externalId, number);
  const currency = String(mapped.currency ?? "")
    .trim()
    .toUpperCase();
  if (currency && currency !== batch.currency)
    errors.push("Row currency differs from the batch");
  const common = {
    batch_id: batch.id,
    row_number: rowNumber,
    employee_id: match.employeeId,
    external_employee_id: externalId,
    employee_number: number,
    raw_row: raw,
    mapping_status: match.status,
  };
  if (batch.batch_type === "compensation_change") {
    const effective_date = safe("effective_date", date),
      new_amount = safe("new_amount", money),
      old_amount = safe("old_amount", money);
    return {
      ...common,
      effective_date,
      new_amount,
      old_amount,
      currency: currency || batch.currency,
      import_error: errors.join("; ") || null,
      validation_status: "invalid",
    };
  }
  for (const [field, expected] of [
    ["pay_period_start", batch.pay_period_start],
    ["pay_period_end", batch.pay_period_end],
    ["payment_date", batch.pay_date],
  ]) {
    const actual = safe(field, date);
    if (actual && actual !== expected)
      errors.push(`${field} differs from the batch`);
  }
  const amounts = Object.fromEntries(
    [
      "gross_pay",
      "regular_pay",
      "overtime_pay",
      "allowances",
      "bonus",
      "tax",
      "other_deductions",
      "net_pay",
    ].map((field) => [field, safe(field, money)]),
  );
  const detail = Object.fromEntries(
    ["earnings", "deductions", "taxes", "employer_values"].map((field) => [
      field,
      safe(field, items),
    ]),
  );
  return {
    ...common,
    ...amounts,
    ...detail,
    employee_email: String(mapped.employee_email ?? "").trim() || null,
    import_error: errors.join("; ") || null,
    validation_status: "invalid",
  };
}

export function validateHeaders(headers, columnMap) {
  const targets = new Set();
  for (const header of headers) {
    const target =
      columnMap[
        String(header ?? "")
          .trim()
          .toLowerCase()
      ];
    if (!target) continue;
    if (targets.has(target))
      throw new Error(`Multiple source columns map to ${target}`);
    targets.add(target);
  }
}
