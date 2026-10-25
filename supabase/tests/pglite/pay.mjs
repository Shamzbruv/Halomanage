import {
  formatPayMoney,
  sumPayAmounts,
  formatPayDate,
} from "../../../web/lib/pay.ts";
import {
  money,
  date,
  matchEmployee,
  stageRow,
  validateHeaders,
} from "../../functions/payroll-import/parser.mjs";
import * as XLSX from "../../functions/payroll-import/vendor/xlsx-0.20.3.mjs";

export async function testPay({ db, as, ok }) {
  const csv =
    "Employee Number,Payment Date,Gross Pay,Net Pay\n001,10/11/2026,1000,850\n";
  const workbook = XLSX.read(csv, {
    type: "string",
    cellDates: true,
    raw: true,
  });
  const csvRow = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]],
  )[0];
  ok(
    "workbook CSV parsing preserves leading zeros and ambiguous date text",
    csvRow["Employee Number"] === "001" &&
      csvRow["Payment Date"] === "10/11/2026",
  );
  const xbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    xbook,
    XLSX.utils.aoa_to_sheet([
      ["Employee Number", "Payment Date"],
      ["001", new Date("2026-10-16T00:00:00Z")],
    ]),
    "Pay",
  );
  const parsedBook = XLSX.read(
    XLSX.write(xbook, { type: "buffer", bookType: "xlsx" }),
    { type: "buffer", cellDates: true, raw: true },
  );
  const xrow = XLSX.utils.sheet_to_json(
    parsedBook.Sheets[parsedBook.SheetNames[0]],
  )[0];
  ok(
    "Excel date cells remain valid source calendar dates",
    date(xrow["Payment Date"]) === "2026-10-16",
  );
  const denied = async (label, fn) => {
    let no = false;
    try {
      await fn();
    } catch {
      no = true;
    }
    ok(label, no);
  };
  for (const [input, output] of [
    ["1,234.50", "1234.50"],
    [0, "0"],
    ["-12.34", "-12.34"],
    ["", null],
    [null, null],
  ])
    ok(`money parser preserves imported ${input}`, money(input) === output);
  for (const input of [
    "1.001",
    "1,23",
    "1e5",
    "USD 10",
    "NaN",
    "1000000000000",
    "1,234,567,890,123",
  ])
    await denied(`money parser rejects ${input}`, () => money(input));
  for (const input of ["10/11/2026", "2026-02-30", "2026-13-01"])
    await denied(
      `ambiguous or impossible source date is rejected: ${input}`,
      () => date(input),
    );
  ok("source dates remain calendar dates", date("2026-02-28") === "2026-02-28");
  const emps = [
    { id: "a", employee_number: "001", external_payroll_id: "x" },
    { id: "b", employee_number: "002", external_payroll_id: "y" },
  ];
  ok(
    "stable identifiers match together",
    matchEmployee(emps, "x", "001").employeeId === "a",
  );
  ok(
    "conflicting stable identifiers require manual reconciliation",
    matchEmployee(emps, "x", "002").status === "ambiguous",
  );
  ok(
    "an unknown second identifier prevents silent fallback",
    matchEmployee(emps, "unknown", "001").employeeId === null,
  );
  ok(
    "no identifiers never auto-match by email",
    matchEmployee(emps, null, null).employeeId === null,
  );
  const source = stageRow(
    {
      employee_number: "001",
      currency: "USD",
      gross_pay: "100.999",
      net_pay: "90",
      payment_date: "01/02/2026",
    },
    {},
    {
      id: "test",
      currency: "JMD",
      batch_type: "pay_run_results",
      pay_date: "2026-02-01",
    },
    emps,
    1,
  );
  ok(
    "source currency, money and date errors survive staging",
    source.import_error.includes("currency") &&
      source.import_error.includes("gross_pay") &&
      source.import_error.includes("payment_date"),
  );
  await denied(
    "duplicate source headers cannot silently select one amount",
    () =>
      validateHeaders(["Gross Pay", "gross pay"], { "gross pay": "gross_pay" }),
  );
  await denied("distinct headers cannot map to the same amount", () =>
    validateHeaders(["Salary", "Gross"], {
      salary: "gross_pay",
      gross: "gross_pay",
    }),
  );
  const ORG = "fc000000-0000-0000-0000-000000000001",
    OTHER = "fc000000-0000-0000-0000-000000000002";
  const users = [1, 2, 3, 4].map(
      (n) => `fc100000-0000-0000-0000-00000000000${n}`,
    ),
    emp = [1, 2, 3, 4].map((n) => `fc200000-0000-0000-0000-00000000000${n}`);
  await db.exec(
    `insert into public.organizations(id,name,slug,timezone) values('${ORG}','Pay Tests Ltd','pay-hr-tests','America/Jamaica'),('${OTHER}','Other Pay','pay-other-tests','UTC')`,
  );
  for (let i = 0; i < 4; i++)
    await db.exec(
      `insert into auth.users(id,email) values('${users[i]}','pay-${i}@test.invalid');insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date) values('${emp[i]}','${i === 3 ? OTHER : ORG}','${users[i]}','PAY-${i}','Pay','Person ${i}','active','2020-01-01');insert into public.role_assignments(organization_id,user_id,role) values('${i === 3 ? OTHER : ORG}','${users[i]}','${i === 0 || i === 3 ? "admin" : "employee"}')`,
    );
  const api = (
    await db.query(
      `select bool_and(not p.prosecdef and not has_function_privilege('anon',p.oid,'EXECUTE')) safe,count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('get_my_pay','get_payslip','create_payroll_import_batch','recompute_payroll_batch_status','approve_payroll_import','reject_payroll_import','resolve_payroll_row_match','resolve_compensation_row_match','submit_pay_query','reply_pay_query','claim_payroll_processing','reconcile_payroll_row')`,
    )
  ).rows[0];
  ok(
    "all pay API entry points are invokers and deny anonymous execution",
    api.safe && Number(api.n) === 12,
  );
  const create = async (hash, currency = "JMD", parent = null) =>
    as(
      users[0],
      async () =>
        (
          await db.query(
            `select * from public.create_payroll_import_batch('${ORG}','pay_run_results','pay.csv','${ORG}/pay.csv','${hash}','2026-10-01','2026-10-15','2026-10-16','${currency}',null,${parent ? `'${parent}'` : "null"})`,
          )
        ).rows[0],
    );
  const row = async (
    batch,
    employee,
    n = 1,
    gross = 1000,
    net = 850,
    tax = 100,
    other = 50,
  ) =>
    (
      await db.query(
        `insert into public.payroll_import_rows(batch_id,row_number,employee_id,gross_pay,net_pay,tax,other_deductions,raw_row,mapping_status,validation_status) values('${batch}',${n},${employee ? `'${employee}'` : "null"},${gross},${net},${tax},${other},'{"private_source":"bank secret"}','${employee ? "matched" : "unmatched"}','valid') returning id`,
      )
    ).rows[0].id;
  const approve = (batch) =>
    as(users[0], () =>
      db.query(`select * from public.approve_payroll_import('${batch}')`),
    );
  let b = await create("one");
  ok("upload retry reuses its batch", (await create("one")).id === b.id);
  await denied("empty batch cannot be approved", () => approve(b.id));
  await denied("cross-tenant correction target is rejected", () =>
    as(users[3], () =>
      db.query(
        `select public.create_payroll_import_batch('${OTHER}','pay_run_results','p.csv','${OTHER}/p.csv','x','2026-10-01','2026-10-15','2026-10-16','JMD',null,'${b.id}')`,
      ),
    ),
  );
  await denied("source path cannot cross tenants", () =>
    as(users[0], () =>
      db.query(
        `select public.create_payroll_import_batch('${ORG}','pay_run_results','p.csv','${OTHER}/p.csv','badpath','2026-10-01','2026-10-15','2026-10-16','JMD')`,
      ),
    ),
  );
  await denied("pay runs require dates", () =>
    as(users[0], () =>
      db.query(
        `select public.create_payroll_import_batch('${ORG}','pay_run_results','p.csv','${ORG}/p.csv','nodate')`,
      ),
    ),
  );
  await denied(
    "service-role row staging cannot target another tenant employee",
    () => row(b.id, emp[3]),
  );
  const id1 = await row(b.id, emp[1]),
    id2 = await row(b.id, emp[2], 2);
  await as(users[0], async () => {
    await db.query(`select public.claim_payroll_processing('${b.id}')`);
    await denied("processing claim is atomic", () =>
      db.query(`select public.claim_payroll_processing('${b.id}')`),
    );
  });
  await approve(b.id);
  await approve(b.id);
  ok(
    "payslip publication notifies each employee once",
    Number(
      (
        await db.query(
          `select count(*) n from public.notifications where organization_id='${ORG}' and type='pay.payslip_published'`,
        )
      ).rows[0].n,
    ) === 2,
  );
  ok(
    "approval retry publishes each employee once",
    Number(
      (
        await db.query(
          `select count(*) n from public.published_payroll_records where batch_id='${b.id}'`,
        )
      ).rows[0].n,
    ) === 2,
  );
  await as(users[1], async () => {
    const pay = (await db.query(`select public.get_my_pay(2026) p`)).rows[0].p;
    ok(
      "employee sees only their own pay",
      pay.total === 1 &&
        pay.records[0].id === id1 &&
        pay.totals[0].net === "850.00",
    );
    ok(
      "raw source rows are not exposed to employees",
      Number(
        (
          await db.query(
            `select count(*) n from public.payroll_import_rows where batch_id='${b.id}'`,
          )
        ).rows[0].n,
      ) === 0,
    );
    ok(
      "shared source file metadata is not exposed to employees",
      Number(
        (
          await db.query(
            `select count(*) n from public.payroll_import_batches where id='${b.id}'`,
          )
        ).rows[0].n,
      ) === 0,
    );
    const slip = (await db.query(`select public.get_payslip('${id1}') p`))
      .rows[0].p;
    ok(
      "safe payslip has no raw spreadsheet data",
      !JSON.stringify(slip).includes("bank secret") &&
        slip.snapshot.employee_name === "Pay Person 1",
    );
    await denied("another employee payslip is denied", () =>
      db.query(`select public.get_payslip('${id2}')`),
    );
    await denied("employees cannot recompute posted batches", () =>
      db.query(`select public.recompute_payroll_batch_status('${b.id}')`),
    );
  });
  await denied("another organization cannot read a published payslip", () =>
    as(users[3], () => db.query(`select public.get_payslip('${id1}')`)),
  );
  await denied(
    "posted source amounts are immutable even for service staging",
    () =>
      db.query(
        `update public.payroll_import_rows set net_pay=1 where id='${id1}'`,
      ),
  );
  await denied("posted batch metadata is immutable", () =>
    db.query(
      `update public.payroll_import_batches set currency='USD' where id='${b.id}'`,
    ),
  );
  await denied("posted payslip snapshot cannot change", () =>
    db.query(
      `update public.published_payroll_records set snapshot='{}' where id='${id1}'`,
    ),
  );
  await denied("published payslips cannot be deleted", () =>
    db.query(`delete from public.published_payroll_records where id='${id1}'`),
  );
  await denied("approved batch cannot be rejected", () =>
    as(users[0], () =>
      db.query(
        `select public.reject_payroll_import('${b.id}','Rejected later')`,
      ),
    ),
  );
  await denied("approved batch cannot be recomputed", () =>
    as(users[0], () =>
      db.query(`select public.recompute_payroll_batch_status('${b.id}')`),
    ),
  );
  await db.exec(
    `update public.employees set last_name='Changed later' where id='${emp[1]}';update public.organizations set name='Renamed employer' where id='${ORG}'`,
  );
  await as(users[1], async () => {
    const s = (await db.query(`select public.get_payslip('${id1}') p`)).rows[0]
      .p;
    ok(
      "published identity does not change with current HR records",
      s.snapshot.employee_name === "Pay Person 1" &&
        s.snapshot.employer_name === "Pay Tests Ltd",
    );
  });
  const correction = await create("correct", "JMD", b.id),
    newid = await row(correction.id, emp[1], 1, 1100, 950);
  await approve(correction.id);
  await as(users[1], async () => {
    const p = (await db.query(`select public.get_my_pay(2026) p`)).rows[0].p;
    ok(
      "corrections replace original amounts in currency totals",
      p.total === 1 && p.totals[0].net === "950.00",
    );
    const old = (await db.query(`select public.get_payslip('${id1}') p`))
      .rows[0].p;
    ok(
      "old payslip links remain accessible and link to replacement",
      old.replaced_by === newid,
    );
  });
  await as(users[2], async () => {
    const p = (await db.query(`select public.get_my_pay(2026) p`)).rows[0].p;
    ok(
      "partial batch correction preserves omitted employee pay",
      p.total === 1 && p.records[0].id === id2,
    );
  });
  const branch = await create("branch", "JMD", b.id);
  await row(branch.id, emp[1]);
  await denied(
    "already replaced records cannot fork into a second correction",
    () => approve(branch.id),
  );
  const usd = await create("usd", "USD");
  await row(usd.id, emp[1], 1, 500, 400, 100, "null");
  await approve(usd.id);
  await as(users[1], async () => {
    const p = (await db.query(`select public.get_my_pay(2026) p`)).rows[0].p;
    ok(
      "year totals never combine currencies",
      p.totals.length === 2 &&
        p.totals.find((t) => t.currency === "USD").net === "400.00",
    );
    ok(
      "missing deductions remain unknown in totals",
      p.totals.find((t) => t.currency === "USD").other_deductions === null,
    );
    const f = (await db.query(`select public.get_my_pay(2026,'JMD',2) p`))
      .rows[0].p;
    ok(
      "pagination and currency filters do not change totals",
      f.total === 1 && f.records.length === 0 && f.totals[0].net === "950.00",
    );
  });
  const invalid = await create("invalid");
  const invalidrow = await row(invalid.id, emp[1], 1, 1000, 999);
  await denied(
    "approval recounts and detects inconsistent imported totals",
    () => approve(invalid.id),
  );
  await db.exec(
    `update public.payroll_import_rows set net_pay=850,import_error='Invalid source date' where id='${invalidrow}'`,
  );
  await as(users[0], () =>
    db.query(
      `select public.reconcile_payroll_row('${invalidrow}','${emp[2]}','Confirmed number against source payroll',false)`,
    ),
  );
  await denied("employee rematch cannot erase source parsing errors", () =>
    approve(invalid.id),
  );
  await denied("rematch cannot assign another tenant", () =>
    as(users[0], () =>
      db.query(
        `select public.resolve_payroll_row_match('${invalidrow}','${emp[3]}')`,
      ),
    ),
  );
  const dupe = await create("dupe");
  await row(dupe.id, emp[1]);
  await row(dupe.id, emp[1], 2);
  await denied("duplicate employees block publication", () => approve(dupe.id));
  await db.exec(
    `insert into public.employee_compensation(organization_id,employee_id,amount,currency,start_date,change_notes) values('${ORG}','${emp[1]}',1000,'JMD','2026-01-01','Confidential manager deliberation')`,
  );
  await as(users[1], async () => {
    const c = (
      await db.query(
        `select change_notes from public.employee_compensation where employee_id='${emp[1]}'`,
      )
    ).rows[0];
    ok(
      "confidential notes are absent from employee compensation rows",
      c.change_notes === null,
    );
    ok(
      "employee cannot read private HR notes",
      Number(
        (
          await db.query(
            `select count(*) n from public.compensation_private_notes where employee_id='${emp[1]}'`,
          )
        ).rows[0].n,
      ) === 0,
    );
  });
  await as(users[0], async () => {
    ok(
      "authorized HR retains confidential notes",
      (
        await db.query(
          `select note from public.compensation_private_notes where employee_id='${emp[1]}'`,
        )
      ).rows[0].note === "Confidential manager deliberation",
    );
  });
  const key = "fc900000-0000-0000-0000-000000000001";
  const submit = () =>
    as(
      users[1],
      async () =>
        (
          await db.query(
            `select * from public.submit_pay_query('amount','Incorrect overtime','Please check the overtime amount on this pay run.','${key}','${newid}')`,
          )
        ).rows[0],
    );
  const q = await submit();
  ok("pay query retry is idempotent", (await submit()).id === q.id);
  await denied("other employees cannot read a pay query thread", () =>
    as(users[2], async () => {
      const n = (
        await db.query(
          `select count(*) n from public.pay_queries where id='${q.id}'`,
        )
      ).rows[0].n;
      if (Number(n) === 0) throw new Error("denied");
    }),
  );
  await denied("employees cannot resolve their own pay queries", () =>
    as(users[1], () =>
      db.query(
        `select public.reply_pay_query('${q.id}','I have resolved this myself','resolved')`,
      ),
    ),
  );
  await denied("a resolution cannot link another employee payslip", () =>
    as(users[0], () =>
      db.query(
        `select public.reply_pay_query('${q.id}','Reviewed and corrected the record','resolved','${id2}')`,
      ),
    ),
  );
  await as(users[0], () =>
    db.query(
      `select public.reply_pay_query('${q.id}','The imported correction includes the overtime adjustment','resolved','${newid}')`,
    ),
  );
  await as(users[1], async () => {
    const qs = (
      await db.query(
        `select status,resolution_payslip_id from public.pay_queries where id='${q.id}'`,
      )
    ).rows[0];
    ok(
      "employee sees HR resolution and linked payslip",
      qs.status === "resolved" && qs.resolution_payslip_id === newid,
    );
    await db.query(
      `select public.reply_pay_query('${q.id}','Please confirm the source overtime hours too.','open')`,
    );
  });
  ok(
    "follow-up reopens resolved query",
    (await db.query(`select status from public.pay_queries where id='${q.id}'`))
      .rows[0].status === "open",
  );
  await denied("query messages cannot be overwritten", () =>
    db.query(
      `update public.pay_query_messages set body='edited' where query_id='${q.id}'`,
    ),
  );
  await denied("another tenant cannot respond to pay queries", () =>
    as(users[3], () =>
      db.query(
        `select public.reply_pay_query('${q.id}','Not my organization query','resolved')`,
      ),
    ),
  );
  const malformed = await create("items");
  await row(malformed.id, emp[1]);
  await db.exec(
    `update public.payroll_import_rows set taxes='[{"label":"Income tax","amount":"100"}]',deductions='[{"label":"Pension","amount":"50"}]',earnings='[{"label":"Salary","amount":"1000"}]' where batch_id='${malformed.id}'`,
  );
  await approve(malformed.id);
  await as(users[1], async () => {
    const slip = (
      await db.query(
        `select public.get_payslip((select id from public.published_payroll_records where batch_id='${malformed.id}')) p`,
      )
    ).rows[0].p;
    ok(
      "supported itemization is preserved in published payslips",
      slip.snapshot.taxes[0].label === "Income tax",
    );
  });
  const mismatch = await create("item-mismatch");
  await row(mismatch.id, emp[1]);
  await db.exec(
    `update public.payroll_import_rows set taxes='[{"label":"Tax","amount":"99"}]' where batch_id='${mismatch.id}'`,
  );
  await denied("itemized values must agree with the imported total", () =>
    approve(mismatch.id),
  );
  await db.exec(
    `update public.payroll_import_rows set taxes='[{"label":"Tax","amount":"invalid"}]' where batch_id='${mismatch.id}'`,
  );
  await denied("malformed itemization cannot publish", () =>
    approve(mismatch.id),
  );
  await db.exec(
    `insert into public.organization_security_policies(organization_id,mfa_policy) values('${ORG}','everyone') on conflict(organization_id) do update set mfa_policy='everyone'`,
  );
  await db.exec(
    `insert into storage.objects(bucket_id,name) values('payroll-imports','${ORG}/pay-source.csv');`,
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await as(users[0], async () => {
    ok(
      "required MFA protects raw payroll files",
      Number(
        (
          await db.query(
            `select count(*) n from storage.objects where bucket_id='payroll-imports' and name='${ORG}/pay-source.csv'`,
          )
        ).rows[0].n,
      ) === 0,
    );
  });

  await denied("required MFA blocks direct payslip RPC access", () =>
    as(users[1], () => db.query(`select public.get_payslip('${newid}')`)),
  );
  await as(users[1], async () => {
    ok(
      "required MFA also blocks direct table access",
      Number(
        (
          await db.query(
            `select count(*) n from public.published_payroll_records where employee_id='${emp[1]}'`,
          )
        ).rows[0].n,
      ) === 0,
    );
  });
  await denied("required MFA blocks pay-query updates", () =>
    as(users[1], () =>
      db.query(
        `select public.reply_pay_query('${q.id}','Trying without multi factor verification','open')`,
      ),
    ),
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  await as(users[0], async () => {
    ok(
      "verified payroll reviewer can read raw payroll files",
      Number(
        (
          await db.query(
            `select count(*) n from storage.objects where bucket_id='payroll-imports' and name='${ORG}/pay-source.csv'`,
          )
        ).rows[0].n,
      ) === 1,
    );
  });

  await as(users[1], async () => {
    ok(
      "MFA verified session can open a payslip",
      !!(await db.query(`select public.get_payslip('${newid}') p`)).rows[0].p,
    );
  });
  await db.exec(
    `update public.organization_security_policies set mfa_policy='optional' where organization_id='${ORG}'; select set_config('request.jwt.claims','',false)`,
  );
  // Revoke compensation alone: payslips must still work. Revoke payroll next: deny.
  await db.exec(
    `insert into public.role_permissions(organization_id,role,permission) select '${ORG}',role,permission from public.role_permissions where organization_id is null and role='employee';delete from public.role_permissions where organization_id='${ORG}' and role='employee' and permission='compensation.read_self'`,
  );
  await as(users[1], async () => {
    ok(
      "payroll access is independent of compensation permission",
      !!(await db.query(`select public.get_my_pay(2026) p`)).rows[0].p,
    );
  });
  await db.exec(
    `delete from public.role_permissions where organization_id='${ORG}' and role='employee' and permission='payroll.read_self'`,
  );
  await denied("revoked self pay permission blocks payslip RPC", () =>
    as(users[1], () => db.query(`select public.get_payslip('${newid}')`)),
  );
  await as(users[1], async () => {
    ok(
      "revoked self pay permission also blocks legacy view",
      Number(
        (
          await db.query(
            `select count(*) n from public.current_payroll_records where employee_id='${emp[1]}'`,
          )
        ).rows[0].n,
      ) === 0,
    );
  });
  ok(
    "money display never substitutes a default currency",
    formatPayMoney("12.30", "JMD") === "JMD 12.30",
  );
  ok(
    "money display preserves large exact decimal totals",
    formatPayMoney("999999999999999999.99", "JMD") ===
      "JMD 999,999,999,999,999,999.99",
  );
  ok(
    "display sums preserve cents exactly",
    sumPayAmounts("0.10", "0.20") === "0.30",
  );
  ok(
    "unknown components never become a zero total",
    sumPayAmounts("0", null) === null,
  );
  ok(
    "negative adjustment sums are exact",
    sumPayAmounts("-1.01", "0.10") === "-0.91",
  );
  ok(
    "calendar date formatter uses the recorded date",
    formatPayDate("2026-10-25").includes("25 Oct 2026"),
  );
}
