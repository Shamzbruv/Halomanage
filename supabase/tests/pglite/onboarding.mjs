import { randomUUID } from "node:crypto";
export async function testOnboarding({ db, as, ok }) {
  const ORG = "cb0b0000-0000-0000-0000-000000000001",
    OTHER = "cb0b0000-0000-0000-0000-000000000002";
  const users = Array.from(
      { length: 9 },
      (_, i) => `cb0b1000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    ),
    emps = Array.from(
      { length: 9 },
      (_, i) => `cb0b2000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
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
  await db.exec(
    `insert into public.organizations(id,name,slug,timezone) values('${ORG}','Onboarding HR','onboarding-hr-tests','America/Jamaica'),('${OTHER}','Other Onboarding','onboarding-other-tests','UTC')`,
  );
  for (let i = 0; i < 9; i++)
    await db.exec(
      `insert into auth.users(id,email) values('${users[i]}','onboarding-${i}@test.invalid');insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date) values('${emps[i]}','${i === 4 ? OTHER : ORG}','${users[i]}','ONB-${i}','Onboarding','Person ${i}','${i === 1 ? "prehire" : i === 5 ? "terminated" : i === 6 ? "leave" : "active"}','2026-10-01');${[2, 3, 7].includes(i) ? "" : `insert into public.role_assignments(organization_id,user_id,role) values('${i === 4 ? OTHER : ORG}','${users[i]}','${i === 0 || i === 4 ? "admin" : "employee"}');`}`,
    );
  for (const [i, name, perms] of [
    [
      2,
      "Scoped onboarding manager",
      ["onboarding.manage_team", "onboarding.read_team"],
    ],
    [3, "IT task owner", []],
    [7, "Templates only", ["onboarding.manage_templates"]],
  ]) {
    const role = (
      await db.query(
        `insert into public.organization_roles(organization_id,name) values($1,$2) returning id`,
        [ORG, name],
      )
    ).rows[0].id;
    for (const p of perms)
      await db.query(
        `insert into public.role_permissions(organization_id,custom_role_id,permission) values($1,$2,$3)`,
        [ORG, role, p],
      );
    await db.query(
      `insert into public.role_assignments(organization_id,user_id,custom_role_id) values($1,$2,$3)`,
      [ORG, users[i], role],
    );
  }
  await db.exec(
    `insert into public.management_scope(organization_id,actor_user_id,employee_id,scope_reason) values('${ORG}','${users[2]}','${emps[1]}','supervisor')`,
  );
  const call = async (i, name, args = []) =>
    as(
      users[i],
      async () =>
        (
          await db.query(
            `select * from public.${name}(${args.map((_, j) => "$" + (j + 1)).join(",")})`,
            args,
          )
        ).rows[0],
    );
  const task = async (i, id) =>
    (await call(i, "get_onboarding_task", [id])).get_onboarding_task;
  const run = async (i, id) =>
    (await call(i, "get_onboarding_run", [id])).get_onboarding_run;
  const template = await call(7, "create_onboarding_template", [
    ORG,
    "Role-specific induction",
    false,
  ]);
  ok("templates-only HR can atomically create a versioned plan", !!template.id);
  const step = async (data, id = null) =>
    call(7, "save_onboarding_step", [
      template.id,
      id,
      JSON.stringify({
        title: "Welcome",
        step_type: "task",
        assignee_type: "employee",
        due_anchor: "hire_date",
        due_offset_days: 0,
        required: true,
        phase: "first_day",
        dependency_step_ids: [],
        ...data,
      }),
    ]);
  const a = await step({ title: "Read welcome instructions" }),
    b = await step({
      title: "Structured reflection",
      step_type: "form",
      form_schema: {
        fields: [
          {
            key: "support",
            label: "What support do you need?",
            type: "text",
            required: true,
          },
          {
            key: "ready",
            label: "Ready for the next stage",
            type: "checkbox",
            required: true,
          },
        ],
      },
      dependency_step_ids: [a.id],
    }),
    c = await step({
      title: "Handbook attestation",
      step_type: "signature",
      dependency_step_ids: [b.id],
    }),
    d = await step({ title: "Upload evidence", step_type: "document_upload" }),
    e = await step({
      title: "Prepare equipment",
      assignee_type: "it",
      assignee_employee_id: emps[3],
    }),
    optional = await step({ title: "Optional introduction", required: false });
  await denied("unknown prerequisites cannot be silently discarded", () =>
    step({ dependency_step_ids: [randomUUID()] }),
  );
  await denied("self-dependent steps are rejected", () =>
    step({ dependency_step_ids: [a.id] }, a.id),
  );
  await denied("cyclic dependencies are rejected", () =>
    step({ dependency_step_ids: [b.id] }, a.id),
  );
  await denied("duplicate form keys are rejected", () =>
    step({
      step_type: "form",
      form_schema: {
        fields: [
          { key: "x", label: "One", type: "text" },
          { key: "x", label: "Two", type: "text" },
        ],
      },
    }),
  );
  await denied("unsupported form types are rejected", () =>
    step({
      step_type: "form",
      form_schema: { fields: [{ key: "x", label: "One", type: "password" }] },
    }),
  );
  await denied("terminated staff cannot own template steps", () =>
    step({ assignee_type: "it", assignee_employee_id: emps[5] }),
  );
  await denied("templates-only role cannot start employee plans", async () =>
    call(7, "start_onboarding", [emps[1], template.id]),
  );
  await denied(
    "scoped managers cannot start plans outside their scope",
    async () => call(2, "start_onboarding", [emps[8], template.id]),
  );
  const started = await call(2, "start_onboarding", [emps[1], template.id]);
  ok(
    "scoped managers can start prehire onboarding within scope",
    started.status === "in_progress",
  );
  const retry = await call(0, "start_onboarding", [emps[1], template.id]);
  ok(
    "repeated start returns the existing active plan",
    retry.id === started.id,
  );
  const another = await call(7, "create_onboarding_template", [
    ORG,
    "Other process",
    false,
  ]);
  await call(7, "save_onboarding_step", [
    another.id,
    null,
    JSON.stringify({
      title: "Other step",
      step_type: "task",
      assignee_type: "employee",
      due_anchor: "hire_date",
      due_offset_days: 0,
      required: true,
    }),
  ]);
  await denied(
    "another template cannot create a second active plan",
    async () => call(0, "start_onboarding", [emps[1], another.id]),
  );
  await denied("terminated employees cannot start onboarding", async () =>
    call(0, "start_onboarding", [emps[5], template.id]),
  );
  const detail = await run(0, started.id),
    tasks = Object.fromEntries(
      detail.tasks.map((t) => [t.template_step_id, t]),
    );
  ok(
    "started tasks preserve configured forms and attestation requirements",
    tasks[b.id].form_schema.fields.length === 2 &&
      tasks[c.id].requires_signature,
  );
  ok(
    "due dates use the employee hire-date anchor",
    tasks[a.id].due_date === "2026-10-01",
  );
  await denied("other tenants cannot read task links", () =>
    task(4, tasks[a.id].id),
  );
  await denied("unassigned coworkers cannot complete tasks", async () =>
    call(8, "complete_onboarding_task", [tasks[a.id].id, null]),
  );
  await denied("scoped manager cannot cancel an out-of-scope plan", async () =>
    call(2, "cancel_onboarding_run", [
      (await call(0, "start_onboarding", [emps[8], template.id])).id,
      "Not my employee",
    ]),
  );
  await denied("prerequisites are enforced before completion", async () =>
    call(1, "complete_onboarding_task", [
      tasks[b.id].id,
      JSON.stringify({ answers: { support: "Nothing", ready: true } }),
    ]),
  );
  await call(1, "complete_onboarding_task", [tasks[a.id].id, null]);
  ok(
    "prehire account can complete its assigned ordinary task",
    (await task(1, tasks[a.id].id)).status === "completed",
  );
  await denied("completed-task retries still check authorization", async () =>
    call(8, "complete_onboarding_task", [tasks[a.id].id, null]),
  );
  await denied("a required structured answer cannot be omitted", async () =>
    call(1, "complete_onboarding_task", [
      tasks[b.id].id,
      JSON.stringify({ answers: { support: "I need access" } }),
    ]),
  );
  await denied(
    "form confirmation fields must have the correct type",
    async () =>
      call(1, "complete_onboarding_task", [
        tasks[b.id].id,
        JSON.stringify({ answers: { support: "Access", ready: "yes" } }),
      ]),
  );
  await denied("unconfigured answers cannot be smuggled into forms", async () =>
    call(1, "complete_onboarding_task", [
      tasks[b.id].id,
      JSON.stringify({
        answers: { support: "Access", ready: true, bank: "private" },
      }),
    ]),
  );
  await denied("HR cannot submit an employee reflection for them", async () =>
    call(0, "complete_onboarding_task", [
      tasks[b.id].id,
      JSON.stringify({ answers: { support: "None", ready: true } }),
    ]),
  );
  await call(1, "complete_onboarding_task", [
    tasks[b.id].id,
    JSON.stringify({
      answers: { support: "Need a screen reader orientation", ready: true },
    }),
  ]);
  const response = await task(1, tasks[b.id].id);
  ok(
    "structured answers remain accessible to the employee",
    response.response.answers.support.includes("screen reader"),
  );
  ok(
    "scoped monitoring excludes private response content",
    (await task(2, tasks[b.id].id)).response === null,
  );
  await as(users[2], async () =>
    ok(
      "response-table RLS matches the safe monitoring projection",
      (
        await db.query(
          `select * from public.onboarding_task_responses where task_id=$1`,
          [tasks[b.id].id],
        )
      ).rows.length === 0,
    ),
  );
  await as(users[2], async () =>
    ok(
      "legacy task-table reads contain only the response marker",
      !JSON.stringify(
        (
          await db.query(
            `select completion_data from public.onboarding_tasks where id=$1`,
            [tasks[b.id].id],
          )
        ).rows,
      ).includes("screen reader"),
    ),
  );
  await denied("signature steps require explicit confirmation", async () =>
    call(1, "complete_onboarding_task", [
      tasks[c.id].id,
      JSON.stringify({ typed_name: "Onboarding Person 1" }),
    ]),
  );
  await denied("signature steps require a typed name", async () =>
    call(1, "complete_onboarding_task", [
      tasks[c.id].id,
      JSON.stringify({ confirmed: true }),
    ]),
  );
  await denied("HR cannot attest as the employee", async () =>
    call(0, "complete_onboarding_task", [
      tasks[c.id].id,
      JSON.stringify({ confirmed: true, typed_name: "HR" }),
    ]),
  );
  await denied(
    "personal attestations cannot be reassigned away from the employee",
    async () => call(0, "reassign_onboarding_task", [tasks[c.id].id, emps[0]]),
  );
  await call(1, "complete_onboarding_task", [
    tasks[c.id].id,
    JSON.stringify({ confirmed: true, typed_name: "Onboarding Person 1" }),
  ]);
  ok(
    "attestation records actual actor and server time",
    !!(await task(1, tasks[c.id].id)).signed_at,
  );
  await denied("upload steps cannot complete without evidence", async () =>
    call(1, "complete_onboarding_task", [tasks[d.id].id, null]),
  );
  const path = `${ORG}/${tasks[d.id].id}/${randomUUID()}.pdf`;
  await as(users[1], () =>
    db.query(
      `insert into storage.objects(bucket_id,name) values('onboarding-evidence',$1)`,
      [path],
    ),
  );
  await call(1, "register_onboarding_file", [
    tasks[d.id].id,
    path,
    "Proof.pdf",
    "application/pdf",
    128,
  ]);
  ok(
    "assigned employee can attach a private uploaded artifact",
    (await task(1, tasks[d.id].id)).files.length === 1,
  );
  await call(1, "register_onboarding_file", [
    tasks[d.id].id,
    path,
    "Proof.pdf",
    "application/pdf",
    128,
  ]);
  ok(
    "file-registration retries do not duplicate evidence",
    (await task(1, tasks[d.id].id)).files.length === 1,
  );
  await denied("other employees cannot upload into someone else task", () =>
    as(users[8], () =>
      db.query(
        `insert into storage.objects(bucket_id,name) values('onboarding-evidence',$1)`,
        [`${ORG}/${tasks[d.id].id}/${randomUUID()}.pdf`],
      ),
    ),
  );
  await denied("file registration requires a real uploaded object", async () =>
    call(1, "register_onboarding_file", [
      tasks[d.id].id,
      `${ORG}/${tasks[d.id].id}/${randomUUID()}.pdf`,
      "Missing.pdf",
      "application/pdf",
      128,
    ]),
  );
  await denied("unsupported evidence types are rejected", async () =>
    call(1, "register_onboarding_file", [
      tasks[d.id].id,
      path,
      "Proof.exe",
      "application/x-msdownload",
      128,
    ]),
  );
  await call(1, "complete_onboarding_task", [tasks[d.id].id, null]);
  await denied("completed step cannot accept more evidence", async () =>
    call(1, "register_onboarding_file", [
      tasks[d.id].id,
      path,
      "Proof.pdf",
      "application/pdf",
      128,
    ]),
  );
  await as(users[0], async () =>
    ok(
      "HR cannot delete preserved evidence through Storage",
      (
        await db.query(
          `delete from storage.objects where bucket_id='onboarding-evidence' and name=$1 returning id`,
          [path],
        )
      ).rows.length === 0,
    ),
  );
  const itWork = await call(3, "list_onboarding_work", [ORG, "open", 1]);
  ok(
    "IT owner sees assigned work without full directory permissions",
    itWork.list_onboarding_work.tasks.some((t) => t.id === tasks[e.id].id),
  );
  await denied("IT assignee cannot read the entire employee run", () =>
    run(3, started.id),
  );
  await call(3, "update_onboarding_task_progress", [
    tasks[e.id].id,
    "blocked",
    "Waiting for laptop delivery",
  ]);
  ok(
    "assignee can report a blocker",
    (await task(3, tasks[e.id].id)).status === "blocked",
  );
  const summary = (
    await call(0, "list_onboarding_admin", [ORG, "in_progress", 1, "Person 1"])
  ).list_onboarding_admin;
  ok(
    "HR queue counts blockers and supports search",
    summary.runs[0]?.blocked_tasks === 1,
  );
  await call(0, "reschedule_onboarding_task", [
    tasks[e.id].id,
    "2026-11-10",
    "Supplier delivery date",
  ]);
  await db.query(
    `update public.employees set hire_date='2026-10-02' where id=$1`,
    [emps[1]],
  );
  ok(
    "manual due-date overrides survive hire-date changes",
    (await task(0, tasks[e.id].id)).due_date === "2026-11-10",
  );
  await call(0, "reassign_onboarding_task", [tasks[e.id].id, emps[8]]);
  await denied("previous assignee loses task access after reassignment", () =>
    task(3, tasks[e.id].id),
  );
  await call(8, "complete_onboarding_task", [
    tasks[e.id].id,
    JSON.stringify({ notes: "Equipment ready" }),
  ]);
  const completedRun = await run(1, started.id);
  ok(
    "required work closes the plan while preserving open optional steps",
    completedRun.status === "completed" &&
      completedRun.tasks.find((t) => t.id === tasks[optional.id].id).status ===
        "pending",
  );
  await call(1, "skip_onboarding_task", [
    tasks[optional.id].id,
    "Not needed for this role",
  ]);
  ok(
    "employee can resolve optional work after required work completes",
    (await task(1, tasks[optional.id].id)).status === "skipped",
  );
  await denied("closed task responses cannot be rewritten", async () =>
    call(1, "complete_onboarding_task", [tasks[optional.id].id, null]),
  );
  await denied("closed task instructions cannot change", () =>
    db.query(
      `update public.onboarding_tasks set title='Rewritten' where id=$1`,
      [tasks[a.id].id],
    ),
  );
  await denied("onboarding runs cannot be deleted", () =>
    db.query(`delete from public.onboarding_runs where id=$1`, [started.id]),
  );
  const changed = await step({ title: "Changed future instructions" }, a.id);
  ok(
    "editing a used version creates a new version",
    changed.template_version_id !== a.template_version_id,
  );
  ok(
    "a historical task retains its original instructions",
    (await task(0, tasks[a.id].id)).title === "Read welcome instructions",
  );
  await denied("direct edits cannot mutate used template versions", () =>
    as(users[7], () =>
      db.query(
        `update public.onboarding_template_steps set title='Direct rewrite' where id=$1`,
        [a.id],
      ),
    ),
  );
  await denied(
    "used version identity cannot move to a different template",
    () =>
      as(users[7], () =>
        db.query(
          `update public.onboarding_template_versions set template_id=$1 where id=$2`,
          [another.id, a.template_version_id],
        ),
      ),
  );
  await as(users[7], () =>
    db.query(
      `update public.onboarding_templates set name='Renamed future plan' where id=$1`,
      [template.id],
    ),
  );
  ok(
    "run receipt retains original template name",
    (await run(0, started.id)).template_name === "Role-specific induction",
  );
  const leaveRun = await call(0, "start_onboarding", [emps[6], template.id]);
  ok(
    "employees on leave remain eligible for an onboarding plan",
    !!leaveRun.id,
  );
  const lt = (await run(0, leaveRun.id)).tasks[0];
  await denied("employees cannot waive required work themselves", async () =>
    call(6, "skip_onboarding_task", [lt.id, "Not applicable"]),
  );
  await call(0, "skip_onboarding_task", [
    lt.id,
    "HR approved equivalent orientation",
  ]);
  ok(
    "HR waivers are recorded distinctly from completion",
    (await task(0, lt.id)).status === "skipped",
  );
  await call(0, "cancel_onboarding_run", [
    leaveRun.id,
    "Role change plan no longer needed",
  ]);
  await call(0, "cancel_onboarding_run", [
    leaveRun.id,
    "Role change plan no longer needed",
  ]);
  ok(
    "cancellation is retry-safe and preserves the record",
    (await run(0, leaveRun.id)).status === "cancelled",
  );
  await denied("cancelled runs cannot accept completion", async () =>
    call(6, "complete_onboarding_task", [
      (await run(0, leaveRun.id)).tasks[1].id,
      null,
    ]),
  );
  await denied("cancelled runs cannot be reassigned", async () =>
    call(0, "reassign_onboarding_task", [
      (await run(0, leaveRun.id)).tasks[1].id,
      emps[0],
    ]),
  );
  await db.exec(
    `insert into public.organization_security_policies(organization_id,mfa_policy) values('${ORG}','everyone') on conflict(organization_id) do update set mfa_policy='everyone';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("required MFA protects onboarding task links", () =>
    task(1, tasks[a.id].id),
  );
  await as(users[1], async () =>
    ok(
      "required MFA protects direct onboarding reads",
      (
        await db.query(
          `select id from public.onboarding_tasks where run_id=$1`,
          [started.id],
        )
      ).rows.length === 0,
    ),
  );
  await denied("required MFA protects template configuration", () =>
    step({ title: "Blocked by MFA" }),
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  ok(
    "verified MFA restores authorized task access",
    (await task(1, tasks[a.id].id)).id === tasks[a.id].id,
  );
  await db.exec(
    `update public.organization_security_policies set mfa_policy='optional',step_up_for_sensitive_actions=true where organization_id='${ORG}';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied(
    "sensitive-action step-up protects completion retries",
    async () => call(1, "complete_onboarding_task", [tasks[a.id].id, null]),
  );
  await denied("sensitive-action step-up protects template editing", () =>
    step({ title: "Sensitive configuration" }),
  );
  await db.exec(
    `update public.organization_security_policies set step_up_for_sensitive_actions=false where organization_id='${ORG}';select set_config('request.jwt.claims','',false)`,
  );
  await denied("null work-list scope is rejected", async () =>
    call(1, "list_onboarding_work", [ORG, null, 1]),
  );
  await denied("invalid admin page is rejected", async () =>
    call(0, "list_onboarding_admin", [ORG, "all", 0, ""]),
  );
  const notices = (
    await db.query(
      `select body,link_url from public.notifications where organization_id=$1 and type='onboarding.task_assigned'`,
      [ORG],
    )
  ).rows;
  ok(
    "task notifications use working private task routes without notes",
    notices.length > 0 &&
      notices.every(
        (n) =>
          n.link_url?.startsWith("/onboarding/tasks/") &&
          !String(n.body).includes("screen reader"),
      ),
  );
  const doc = (
    await db.query(
      `insert into public.documents(organization_id,title,category,visibility) values($1,'Induction handbook','policy','org') returning id`,
      [ORG],
    )
  ).rows[0].id;
  const v1 = (
    await db.query(
      `insert into public.document_versions(document_id,version_number,storage_bucket,storage_path,file_name) values($1,1,'company-policies',$2,'Handbook.pdf') returning id`,
      [doc, ORG + "/onboarding-handbook-v1.pdf"],
    )
  ).rows[0].id;
  await db.query(
    `update public.documents set current_version_id=$1 where id=$2`,
    [v1, doc],
  );
  await db.query(
    `insert into storage.objects(bucket_id,name) values('company-policies',$1)`,
    [ORG + "/onboarding-handbook-v1.pdf"],
  );
  const docTemplate = await call(7, "create_onboarding_template", [
    ORG,
    "Document-backed orientation",
    false,
  ]);
  const docStep = await call(7, "save_onboarding_step", [
    docTemplate.id,
    null,
    JSON.stringify({
      title: "Read exact handbook version",
      step_type: "document_review",
      assignee_type: "employee",
      due_anchor: "run_start",
      due_offset_days: 0,
      required: true,
      review_document_id: doc,
    }),
  ]);
  const docOptional = await call(7, "save_onboarding_step", [
    docTemplate.id,
    null,
    JSON.stringify({
      title: "Optional document acknowledgement",
      step_type: "acknowledgement",
      assignee_type: "employee",
      due_anchor: "run_start",
      due_offset_days: 1,
      required: false,
    }),
  ]);
  const docRun = await call(0, "start_onboarding", [emps[6], docTemplate.id]),
    docTasks = (await run(0, docRun.id)).tasks,
    reviewTask = docTasks.find((t) => t.template_step_id === docStep.id),
    optionalTask = docTasks.find((t) => t.template_step_id === docOptional.id);
  ok(
    "review step snapshots the assigned document version",
    reviewTask.review_document?.id === v1,
  );
  await call(6, "attach_onboarding_task_document", [reviewTask.id, doc]);
  const hiddenDoc = (
    await db.query(
      `insert into public.documents(organization_id,employee_id,title,category,visibility) values($1,$2,'Private HR assessment','other','hr_only') returning id`,
      [ORG, emps[6]],
    )
  ).rows[0].id;
  const hiddenVersion = (
    await db.query(
      `insert into public.document_versions(document_id,version_number,storage_path,file_name) values($1,1,$2,'HR.pdf') returning id`,
      [hiddenDoc, ORG + "/" + emps[6] + "/hr-only.pdf"],
    )
  ).rows[0].id;
  await db.query(
    `update public.documents set current_version_id=$1 where id=$2`,
    [hiddenVersion, hiddenDoc],
  );
  await denied("employee cannot attach a guessed HR-only document", async () =>
    call(6, "attach_onboarding_task_document", [reviewTask.id, hiddenDoc]),
  );
  const v2 = (
    await db.query(
      `insert into public.document_versions(document_id,version_number,storage_bucket,storage_path,file_name) values($1,2,'company-policies',$2,'Handbook-v2.pdf') returning id`,
      [doc, ORG + "/onboarding-handbook-v2.pdf"],
    )
  ).rows[0].id;
  await db.query(
    `update public.documents set current_version_id=$1 where id=$2`,
    [v2, doc],
  );
  const afterVersion = await task(6, reviewTask.id);
  ok(
    "document publication does not rewrite the assigned review version",
    afterVersion.review_document?.id === v1,
  );
  ok(
    "evidence link preserves its attached version",
    afterVersion.files.some((f) => f.id === v1),
  );
  await denied(
    "referenced document-version metadata cannot be overwritten",
    () =>
      db.query(
        `update public.document_versions set storage_path='replaced.pdf' where id=$1`,
        [v1],
      ),
  );
  await denied("referenced document-version history cannot be deleted", () =>
    db.query(`delete from public.document_versions where id=$1`, [v1]),
  );
  await as(users[0], async () =>
    ok(
      "referenced underlying document cannot be deleted through Storage",
      (
        await db.query(
          `delete from storage.objects where bucket_id='company-policies' and name=$1 returning id`,
          [ORG + "/onboarding-handbook-v1.pdf"],
        )
      ).rows.length === 0,
    ),
  );
  const wrongPath = `${ORG}/${optionalTask.id}/${randomUUID()}.pdf`;
  await as(users[6], () =>
    db.query(
      `insert into storage.objects(bucket_id,name) values('onboarding-evidence',$1)`,
      [wrongPath],
    ),
  );
  await denied("one task cannot register a different task upload", async () =>
    call(6, "register_onboarding_file", [
      reviewTask.id,
      wrongPath,
      "Wrong task.pdf",
      "application/pdf",
      128,
    ]),
  );
  await denied("document review requires explicit confirmation", async () =>
    call(6, "complete_onboarding_task", [reviewTask.id, null]),
  );
  await call(6, "complete_onboarding_task", [
    reviewTask.id,
    JSON.stringify({ confirmed: true }),
  ]);
  ok(
    "document review completion records the reviewed version",
    (await task(6, reviewTask.id)).response.review_document_version_id === v1,
  );
  const history = (await call(6, "list_onboarding_work", [ORG, "history", 1]))
    .list_onboarding_work;
  ok(
    "history includes cancelled and completed work",
    history.tasks.some((t) => t.id === reviewTask.id),
  );
  const ownerTemplate = await call(7, "create_onboarding_template", [
    ORG,
    "Default-owned preparation",
    false,
  ]);
  await call(7, "save_onboarding_step", [
    ownerTemplate.id,
    null,
    JSON.stringify({
      title: "Prepare accounts",
      step_type: "task",
      assignee_type: "hr",
      due_anchor: "hire_date",
      due_offset_days: 0,
      required: true,
    }),
  ]);
  await call(0, "set_onboarding_responsible", [ORG, "hr", emps[3]]);
  const ownerRun = await call(0, "start_onboarding", [
      emps[6],
      ownerTemplate.id,
    ]),
    ownerTask = (await run(0, ownerRun.id)).tasks[0];
  ok(
    "default HR responsibility resolves to a real owner",
    ownerTask.assigned_to_user_id === users[3],
  );
  await call(0, "set_onboarding_responsible", [ORG, "hr", emps[0]]);
  ok(
    "changing defaults transfers open default-owned tasks",
    (await task(0, ownerTask.id)).assigned_to_user_id === users[0],
  );
  await call(0, "reassign_onboarding_task", [ownerTask.id, emps[8]]);
  await call(0, "set_onboarding_responsible", [ORG, "hr", emps[3]]);
  ok(
    "manual ownership stays separate from organization defaults",
    (await task(0, ownerTask.id)).assigned_to_user_id === users[8],
  );
  await db.query(`update public.employees set user_id=null where id=$1`, [
    emps[8],
  ]);
  ok(
    "unlinking an account clears stale task access",
    (await task(0, ownerTask.id)).assigned_to_user_id === null,
  );
  await db.query(`update public.employees set user_id=$1 where id=$2`, [
    users[8],
    emps[8],
  ]);
  ok(
    "linking an account again restores its manual task assignment",
    (await task(0, ownerTask.id)).assigned_to_user_id === users[8],
  );
  await db.query(`update public.employees set status='suspended' where id=$1`, [
    emps[8],
  ]);
  ok(
    "suspending an assignee clears its task access without losing manual identity",
    (await task(0, ownerTask.id)).assigned_to_user_id === null &&
      (await task(0, ownerTask.id)).assignee_employee_id === emps[8],
  );
  await denied("suspended staff cannot use task links", () =>
    task(8, ownerTask.id),
  );
  await db.query(`update public.employees set status='active' where id=$1`, [
    emps[8],
  ]);
  ok(
    "restoring eligibility restores the original manual assignment",
    (await task(0, ownerTask.id)).assigned_to_user_id === users[8],
  );
  const emptyTemplate = await call(7, "create_onboarding_template", [
    ORG,
    "Empty framework",
    false,
  ]);
  await denied("empty templates cannot create unusable runs", async () =>
    call(0, "start_onboarding", [emps[0], emptyTemplate.id]),
  );
  await as(users[7], () =>
    db.query(
      `update public.onboarding_templates set is_active=false where id=$1`,
      [docTemplate.id],
    ),
  );
  await denied("archived templates cannot start new plans", async () =>
    call(0, "start_onboarding", [emps[0], docTemplate.id]),
  );
  await denied(
    "legacy template step implementation is not a callable bypass",
    () =>
      as(users[1], () =>
        db.query(
          `select onboarding_internal.delete_onboarding_template_step_legacy($1,$2)`,
          [template.id, a.id],
        ),
      ),
  );
  await db.exec(
    `insert into public.organization_network_policies(organization_id,enforcement_mode) values('${ORG}','enforced') on conflict(organization_id) do update set enforcement_mode='enforced';insert into public.organization_network_ranges(organization_id,cidr,label) values('${ORG}','192.0.2.0/24','Office');select set_config('request.headers','{"cf-connecting-ip":"203.0.113.9"}',false)`,
  );
  await denied(
    "employee task reads obey the existing organization network policy",
    () => task(1, tasks[a.id].id),
  );
  await db.exec(
    `select set_config('request.headers','{"cf-connecting-ip":"192.0.2.10"}',false)`,
  );
  ok(
    "an allowed network restores ordinary task access",
    (await task(1, tasks[a.id].id)).id === tasks[a.id].id,
  );
  await db.exec(
    `select set_config('request.headers','{}',false);update public.organization_network_policies set enforcement_mode='disabled' where organization_id='${ORG}'`,
  );
  await denied('missing document objects cannot become attachment evidence',()=>call(0,'attach_onboarding_task_document',[ownerTask.id,doc]));
  const missingFileTemplate=await call(7,'create_onboarding_template',[ORG,'Missing-file review',false]);
  await call(7,'save_onboarding_step',[missingFileTemplate.id,null,JSON.stringify({title:'Read current handbook',step_type:'document_review',assignee_type:'employee',due_anchor:'run_start',due_offset_days:0,required:true,review_document_id:doc})]);
  await denied('a review plan cannot start with an unavailable file',()=>call(0,'start_onboarding',[emps[0],missingFileTemplate.id]));
  await denied('storage maintenance cannot delete a pinned artifact',()=>db.query(`delete from storage.objects where bucket_id='company-policies' and name=$1`,[ORG+'/onboarding-handbook-v1.pdf']));
  await denied('storage maintenance cannot rename a pinned artifact',()=>db.query(`update storage.objects set name='replaced-handbook.pdf' where bucket_id='company-policies' and name=$1`,[ORG+'/onboarding-handbook-v1.pdf']));
  const apis = (
    await db.query(
      `select bool_and(not p.prosecdef and not has_function_privilege('anon',p.oid,'execute')) safe from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('start_onboarding','complete_onboarding_task','skip_onboarding_task','cancel_onboarding_run','attach_onboarding_task_document','get_onboarding_task','get_onboarding_run','list_onboarding_work','list_onboarding_admin','list_onboarding_people','create_onboarding_template','save_onboarding_step')`,
    )
  ).rows[0];
  ok(
    "Onboarding APIs use invoker wrappers and deny anonymous execution",
    apis.safe,
  );
}
