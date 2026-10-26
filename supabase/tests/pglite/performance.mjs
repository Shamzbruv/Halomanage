import { randomUUID } from "node:crypto";
export async function testPerformance({ db, as, ok }) {
  const ORG = "cfe00000-0000-0000-0000-000000000001",
    OTHER = "cfe00000-0000-0000-0000-000000000002";
  const users = Array.from(
      { length: 10 },
      (_, i) => `cfe10000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    ),
    emps = Array.from(
      { length: 10 },
      (_, i) => `cfe20000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    );
  const denied = async (label, fn) => {
    let reject = false;
    try {
      await fn();
    } catch {
      reject = true;
    }
    ok(label, reject);
  };
  await db.exec(
    `insert into public.organizations(id,name,slug,timezone) values('${ORG}','Performance HR','performance-hr-tests','America/Jamaica'),('${OTHER}','Other Performance','performance-other-tests','UTC')`,
  );
  for (let i = 0; i < 10; i++)
    await db.exec(
      `insert into auth.users(id,email) values('${users[i]}','performance-${i}@test.invalid');insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date) values('${emps[i]}','${i === 5 ? OTHER : ORG}','${users[i]}','PERF-${i}','Performance','Person ${i}','${i === 7 ? "leave" : i === 8 ? "terminated" : i === 9 ? "prehire" : "active"}','2020-01-01');${i === 6 ? "" : `insert into public.role_assignments(organization_id,user_id,role) values('${i === 5 ? OTHER : ORG}','${users[i]}','${i === 0 || i === 5 ? "admin" : i === 2 ? "supervisor" : i === 3 ? "manager" : "employee"}');`}`,
    );
  const custom = (
    await db.query(
      `insert into public.organization_roles(organization_id,name) values($1,'Performance-only HR') returning id`,
      [ORG],
    )
  ).rows[0].id;
  await db.query(
    `insert into public.role_permissions(organization_id,custom_role_id,permission) values($1,$2,'appraisal.manage_cycles')`,
    [ORG, custom],
  );
  await db.query(
    `insert into public.role_assignments(organization_id,user_id,custom_role_id) values($1,$2,$3)`,
    [ORG, users[6], custom],
  );
  await db.exec(
    `insert into public.employee_assignments(organization_id,employee_id,supervisor_employee_id,manager_employee_id,start_date,employment_type) values('${ORG}','${emps[1]}','${emps[2]}','${emps[3]}','2020-01-01','full_time'),('${ORG}','${emps[7]}','${emps[2]}','${emps[2]}','2020-01-01','part_time')`,
  );
  const call = async (i, name, args = []) =>
    as(
      users[i],
      async () =>
        (
          await db.query(
            `select * from public.${name}(${args.map((_, n) => "$" + (n + 1)).join(",")})`,
            args,
          )
        ).rows[0],
    );
  const detail = async (i, id) =>
    (await call(i, "get_performance_checkpoint", [id]))
      .get_performance_checkpoint;
  const scale = [1, 2, 3, 4, 5].map((value) => ({
    value,
    label: "Level " + value,
  }));
  const template = await as(
    users[6],
    async () =>
      (
        await db.query(
          `insert into public.appraisal_templates(organization_id,name,rating_scale) values($1,'Evidence-based review',$2::jsonb) returning *`,
          [ORG, JSON.stringify(scale)],
        )
      ).rows[0],
  );
  const section = await as(
    users[6],
    async () =>
      (
        await db.query(
          `insert into public.appraisal_sections(template_id,title,sequence) values($1,'Performance and support',1) returning id`,
          [template.id],
        )
      ).rows[0].id,
  );
  const q = {};
  let seq = 0;
  for (const [type, options, required] of [
    ["text", null, true],
    ["rating_scale", null, true],
    ["numeric_rating", { min: 0, max: 10 }, true],
    ["yes_no", null, true],
    ["multiple_choice", ["Option A", "Option B"], true],
    ["goal", null, true],
    ["optional", null, false],
  ])
    q[type] = await as(
      users[6],
      async () =>
        (
          await db.query(
            `insert into public.appraisal_questions(section_id,prompt,question_type,options,required,sequence) values($1,$2,$3,$4::jsonb,$5,$6) returning id`,
            [
              section,
              "Question " + type,
              type === "optional" ? "text" : type,
              JSON.stringify(options),
              required,
              ++seq,
            ],
          )
        ).rows[0].id,
    );
  ok(
    "performance-only HR can build the framework without directory permission",
    !!q.goal,
  );
  const today = (
    await db.query(`select private.org_today($1)::text local_day`, [ORG])
  ).rows[0].local_day;
  const config = {
    template_id: template.id,
    name: "Targeted review",
    start_date: today,
    review_period_start: "2026-01-01",
    review_period_end: today,
    self_review_due: today,
    supervisor_review_due: today,
    manager_review_due: today,
    acknowledgement_due: today,
    employee_filter: { employee_ids: [emps[1]] },
  };
  const make = async (patch = {}) =>
    call(6, "save_performance_cycle", [
      ORG,
      null,
      JSON.stringify({ ...config, ...patch }),
      null,
    ]);
  await denied("foreign employee filters are rejected", () =>
    make({
      name: "Foreign roster",
      employee_filter: { employee_ids: [emps[5]] },
    }),
  );
  await denied("unknown filters cannot silently broaden a cycle", () =>
    make({ name: "Bad field", employee_filter: { all_people: true } }),
  );
  await denied("deadline order is validated", () =>
    make({ name: "Bad dates", self_review_due: "2020-01-01" }),
  );
  const cycle = await make();
  const roster = await as(
    users[6],
    async () =>
      (
        await db.query(`select * from public.preview_performance_roster($1)`, [
          cycle.id,
        ])
      ).rows,
  );
  ok(
    "cycle targeting actually selects the intended employee",
    roster.length === 1 && roster[0].employee_id === emps[1],
  );
  const people = await as(
    users[6],
    async () =>
      (
        await db.query(`select * from public.list_performance_people($1)`, [
          ORG,
        ])
      ).rows,
  );
  ok(
    "limited performance HR receives minimal eligible employee choices",
    people.some((p) => p.id === emps[1]) &&
      !people.some((p) => [emps[5], emps[8], emps[9]].includes(p.id)),
  );
  await denied("ordinary employees cannot preview an HR roster", () =>
    call(1, "preview_performance_roster", [cycle.id]),
  );
  await denied("other-tenant HR cannot launch a cycle", () =>
    call(5, "launch_appraisal_cycle", [cycle.id]),
  );
  const launched = await call(6, "launch_appraisal_cycle", [cycle.id]),
    iid = launched.id;
  ok(
    "launch creates the checkpoint with its original labels and period",
    launched.employee_name === "Performance Person 1" &&
      (await detail(1, iid)).review_period_start === "2026-01-01",
  );
  const again = await call(6, "launch_appraisal_cycle", [cycle.id]);
  ok(
    "launch retries reuse the original checkpoint",
    again.id === iid &&
      (
        await db.query(
          `select count(*) n from public.appraisal_instances where cycle_id=$1`,
          [cycle.id],
        )
      ).rows[0].n === 1,
  );
  await denied("launched cycles cannot change dates or targeting", () =>
    call(6, "save_performance_cycle", [
      ORG,
      cycle.id,
      JSON.stringify({ ...config, name: "Changed live cycle" }),
      cycle.revision,
    ]),
  );
  const record = await detail(1, iid),
    self = record.reviewers.find((r) => r.role === "self"),
    supervisor = record.reviewers.find((r) => r.role === "supervisor"),
    manager = record.reviewers.find((r) => r.role === "manager");
  ok(
    "independent review stages are assigned in order",
    record.reviewers.length === 3 && record.current_stage_id === self.id,
  );
  const answers = {
    [q.text]: "Specific employee private draft",
    [q.rating_scale]: 4,
    [q.numeric_rating]: 8.5,
    [q.yes_no]: true,
    [q.multiple_choice]: "Option A",
    [q.goal]: {
      title: "Improve service consistency",
      measure: "Meet the documented quality target for three months",
      target_date: "2027-01-31",
      support: "Weekly coaching",
    },
    [q.optional]: "Optional context",
  };
  const save = (i, r, values, version, submit = false, key = randomUUID()) =>
    call(i, "save_appraisal_review", [
      r,
      JSON.stringify(values),
      version,
      key,
      submit,
    ]);
  await denied("later reviewers cannot submit ahead of the self stage", () =>
    save(3, manager.id, answers, 0, true),
  );
  await denied("HR cannot impersonate another reviewer", () =>
    save(6, self.id, answers, 0, true),
  );
  await denied("cross-tenant checkpoint links are denied", () =>
    detail(5, iid),
  );
  await denied("unrelated employees cannot view the checkpoint", () =>
    detail(4, iid),
  );
  await denied("clients cannot forge direct response writes", () =>
    as(users[1], () =>
      db.query(
        `insert into public.appraisal_responses(instance_id,reviewer_id,question_id,response_json) values($1,$2,$3,'"Forged"'::jsonb)`,
        [iid, self.id, q.text],
      ),
    ),
  );
  await denied("duplicate choice labels are rejected", () =>
    as(users[6], () =>
      db.query(
        `update public.appraisal_questions set options='["Same","Same"]'::jsonb where id=$1`,
        [q.multiple_choice],
      ),
    ),
  );
  const key = randomUUID();
  await save(1, self.id, answers, 0, false, key);
  await save(1, self.id, answers, 0, false, key);
  ok(
    "draft save retries increment the version once",
    (await detail(1, iid)).reviewers.find((r) => r.id === self.id)
      .draft_version === 1,
  );
  ok(
    "HR cannot see someone else private draft",
    (await detail(6, iid)).responses.length === 0,
  );
  ok(
    "later reviewers cannot see another draft",
    (await detail(2, iid)).responses.length === 0,
  );
  await as(users[6], async () => {
    ok(
      "raw response RLS also protects drafts",
      (
        await db.query(
          `select * from public.appraisal_responses where instance_id=$1`,
          [iid],
        )
      ).rows.length === 0,
    );
    ok(
      "reviewer metadata does not contain retry payload answers",
      !JSON.stringify(
        (
          await db.query(
            `select * from public.appraisal_reviewers where instance_id=$1`,
            [iid],
          )
        ).rows,
      ).includes("private draft"),
    );
  });
  await denied("retry keys are bound to the saved answer payload", () =>
    save(1, self.id, { ...answers, [q.text]: "Different" }, 0, false, key),
  );
  await denied("a stale browser tab cannot overwrite a newer draft", () =>
    save(1, self.id, answers, 0),
  );
  const partial = { [q.goal]: { title: "An unfinished goal" } };
  await save(1, self.id, partial, 1, false);
  ok(
    "incomplete goal drafts can be saved",
    (await detail(1, iid)).responses.length === 1,
  );
  await denied("required answers prevent an incomplete submission", () =>
    save(1, self.id, partial, 2, true),
  );
  await denied("ratings outside the snapshot scale are rejected", () =>
    save(1, self.id, { ...answers, [q.rating_scale]: 999 }, 2, true),
  );
  await denied("numeric bounds are enforced", () =>
    save(1, self.id, { ...answers, [q.numeric_rating]: 11 }, 2, true),
  );
  await denied("yes/no answers require a boolean", () =>
    save(1, self.id, { ...answers, [q.yes_no]: "Yes" }, 2, true),
  );
  await denied("multiple choice answers must match configured options", () =>
    save(
      1,
      self.id,
      { ...answers, [q.multiple_choice]: "Injected option" },
      2,
      true,
    ),
  );
  await denied("unknown question IDs cannot be written into a review", () =>
    save(1, self.id, { ...answers, [randomUUID()]: "Hidden data" }, 2, true),
  );
  await denied("structured goals need measurable criteria and a date", () =>
    save(
      1,
      self.id,
      { ...answers, [q.goal]: { title: "Try harder" } },
      2,
      true,
    ),
  );
  await denied("goal fields reject structured data in text fields", () =>
    save(
      1,
      self.id,
      {
        ...answers,
        [q.goal]: { ...answers[q.goal], support: { secret: "Nested data" } },
      },
      2,
      true,
    ),
  );
  await as(users[6], async () => {
    await db.query(
      `update public.appraisal_questions set prompt='Future replacement prompt' where id=$1`,
      [q.text],
    );
    await db.query(
      `update public.appraisal_templates set name='Renamed future template',rating_scale=$1::jsonb where id=$2`,
      [
        JSON.stringify([
          { value: 10, label: "Low" },
          { value: 50, label: "High" },
        ]),
        template.id,
      ],
    );
  });
  const fixed = await detail(1, iid);
  ok(
    "template edits do not rewrite launched prompts",
    fixed.form_snapshot.sections[0].questions.find((x) => x.id === q.text)
      .prompt === "Question text",
  );
  ok(
    "the launched rating scale stays unchanged",
    fixed.form_snapshot.rating_scale.some((r) => r.value === 4),
  );
  const submitted = await save(1, self.id, answers, 2, true);
  ok(
    "valid typed self-review advances to supervisor review",
    submitted.save_appraisal_review.status === "submitted" &&
      (await detail(1, iid)).status === "supervisor_review",
  );
  await denied("submitted responses cannot be rewritten", () =>
    db.query(
      `update public.appraisal_responses set response_text='Rewritten' where reviewer_id=$1`,
      [self.id],
    ),
  );
  await denied("source questions cannot be deleted out of old records", () =>
    db.query(`delete from public.appraisal_questions where id=$1`, [q.text]),
  );
  const goals = (await detail(1, iid)).goals;
  ok(
    "submitted self-review goals become proposals rather than automatic achievements",
    goals.length === 1 && goals[0].status === "proposed",
  );
  const gid = goals[0].id;
  await denied("employees cannot agree their own performance goal", () =>
    call(1, "update_performance_goal", [
      iid,
      gid,
      "agree",
      JSON.stringify({ note: "I approve myself" }),
      1,
      null,
    ]),
  );
  await call(2, "update_performance_goal", [
    iid,
    gid,
    "agree",
    JSON.stringify({ note: "Agreed success criteria and coaching" }),
    1,
    null,
  ]);
  await denied("goal progress requires a whole percentage", () =>
    call(1, "update_performance_goal", [
      iid,
      gid,
      "progress",
      JSON.stringify({
        progress: 12.5,
        note: "Fractional progress should fail",
      }),
      2,
      null,
    ]),
  );
  await denied("goal edits enforce the support length", () =>
    call(2, "update_performance_goal", [
      iid,
      gid,
      "edit",
      JSON.stringify({
        title: "Service goal",
        measure: "Valid success criteria",
        target_date: "2027-01-01",
        support: "x".repeat(2001),
        note: "Support must fit",
      }),
      2,
      null,
    ]),
  );
  await call(1, "update_performance_goal", [
    iid,
    gid,
    "progress",
    JSON.stringify({
      progress: 50,
      note: "First month target met; coaching continues",
    }),
    2,
    null,
  ]);
  await denied("stale goal updates cannot erase newer progress", () =>
    call(1, "update_performance_goal", [
      iid,
      gid,
      "progress",
      JSON.stringify({ progress: 10, note: "Stale progress" }),
      2,
      null,
    ]),
  );
  await denied("employees cannot certify their own goal achieved", () =>
    call(1, "update_performance_goal", [
      iid,
      gid,
      "complete",
      JSON.stringify({ note: "I am done" }),
      3,
      null,
    ]),
  );
  await call(2, "update_performance_goal", [
    iid,
    gid,
    "complete",
    JSON.stringify({ note: "Evidence confirms the agreed success criteria" }),
    3,
    null,
  ]);
  ok(
    "goal achievement is independently confirmed with retained progress history",
    (await detail(1, iid)).goals[0].status === "completed" &&
      (await detail(1, iid)).goals[0].events.length === 4,
  );
  await denied("closed goals cannot be silently rewritten", () =>
    call(2, "update_performance_goal", [
      iid,
      gid,
      "edit",
      JSON.stringify({
        title: "Changed",
        measure: "Changed target",
        target_date: "2028-01-01",
        note: "Rewrite old goal",
      }),
      4,
      null,
    ]),
  );
  ok(
    "later assigned reviewers receive submitted earlier stages",
    (await detail(2, iid)).responses.some((a) => a.reviewer_id === self.id),
  );
  const supervisorAnswers = {
    ...answers,
    [q.text]: "Supervisor confidential working draft",
  };
  await save(2, supervisor.id, supervisorAnswers, 0, false);
  ok(
    "employee cannot see unfinished supervisor feedback",
    !(await detail(1, iid)).responses.some(
      (a) => a.reviewer_id === supervisor.id,
    ),
  );
  ok(
    "HR cannot inspect unfinished supervisor drafts",
    !(await detail(6, iid)).responses.some(
      (a) => a.reviewer_id === supervisor.id,
    ),
  );
  await save(2, supervisor.id, supervisorAnswers, 1, true);
  await save(
    3,
    manager.id,
    { ...answers, [q.text]: "Final manager feedback with evidence" },
    0,
    true,
  );
  const released = await detail(1, iid);
  ok(
    "combined feedback is released after independent review",
    released.status === "employee_acknowledgement" &&
      !!released.released_at &&
      released.responses.some((a) => a.reviewer_id === manager.id),
  );
  await denied("someone else cannot acknowledge for the employee", () =>
    call(6, "record_performance_receipt", [iid, "received", null]),
  );
  await denied("disagreement requires an explanation", () =>
    call(1, "record_performance_receipt", [iid, "disagree", ""]),
  );
  await call(1, "record_performance_receipt", [
    iid,
    "disagree",
    "I request HR review of the attendance context used.",
  ]);
  await call(1, "record_performance_receipt", [
    iid,
    "disagree",
    "I request HR review of the attendance context used.",
  ]);
  const signed = await detail(1, iid);
  ok(
    "receipt permits disagreement and opens HR follow-up",
    signed.status === "complete" &&
      signed.query_status === "open" &&
      signed.signoffs.length === 1 &&
      signed.signoffs[0].disposition === "disagree",
  );
  const mk = randomUUID();
  const message = await call(1, "add_performance_message", [
    iid,
    "employee_comment",
    "Please consider the documented context.",
    mk,
    false,
  ]);
  const messageRetry = await call(1, "add_performance_message", [
    iid,
    "employee_comment",
    "Please consider the documented context.",
    mk,
    false,
  ]);
  ok("shared employee comments are retry-safe", message.id === messageRetry.id);
  await denied("shared message retry keys bind the resolution flag", () =>
    call(1, "add_performance_message", [
      iid,
      "employee_comment",
      "Please consider the documented context.",
      mk,
      true,
    ]),
  );
  await call(6, "add_performance_message", [
    iid,
    "hr_response",
    "We reviewed the context and recorded the agreed clarification.",
    randomUUID(),
    true,
  ]);
  ok(
    "HR responses resolve queries without changing original ratings",
    (await detail(1, iid)).query_status === "resolved" &&
      (await detail(1, iid)).responses.find(
        (a) => a.reviewer_id === manager.id && a.question_id === q.rating_scale,
      ).response_json === 4,
  );
  await call(6, "add_performance_message", [
    iid,
    "amendment",
    "Correction: the supporting date was 1 October, not 2 October.",
    randomUUID(),
    false,
  ]);
  ok(
    "amendments stay visible alongside the retained original review",
    (await detail(1, iid)).messages.some((m) => m.kind === "amendment"),
  );
  await denied("shared comments cannot be edited after posting", () =>
    db.query(`update public.appraisal_messages set body='Erased' where id=$1`, [
      message.id,
    ]),
  );
  await denied("employee receipt history is immutable", () =>
    db.query(`delete from public.appraisal_signoffs where instance_id=$1`, [
      iid,
    ]),
  );
  await call(6, "resolve_performance_cycle", [
    cycle.id,
    "close",
    "All checkpoints completed and receipt recorded",
  ]);
  ok(
    "HR can close a resolved cycle",
    (await call(6, "get_performance_cycle", [cycle.id, 1, ""]))
      .get_performance_cycle.status === "closed",
  );
  const work = (await call(1, "list_performance_work", [ORG, "active", 1]))
    .list_performance_work;
  ok(
    "completed checkpoints are excluded from active metrics",
    work.active_count === 0 && work.items.length === 0,
  );
  // Restore the future template scale for the remaining workflow cases.
  await as(users[6], () =>
    db.query(
      `update public.appraisal_templates set rating_scale=$1::jsonb where id=$2`,
      [JSON.stringify(scale), template.id],
    ),
  );
  const leaveCycle = await make({
    name: "Leave staff review",
    employee_filter: { status: ["leave"], employment_types: ["part_time"] },
  });
  const leaveRoster = await as(
    users[6],
    async () =>
      (
        await db.query(`select * from public.preview_performance_roster($1)`, [
          leaveCycle.id,
        ])
      ).rows,
  );
  ok(
    "status and employment filters combine correctly",
    leaveRoster.length === 1 && leaveRoster[0].employee_id === emps[7],
  );
  const leaveInstance = await call(6, "launch_appraisal_cycle", [
    leaveCycle.id,
  ]);
  ok(
    "same supervisor and manager create one independent stage",
    (await detail(7, leaveInstance.id)).reviewers.length === 2,
  );
  await denied("unfinished cycles cannot be prematurely closed", () =>
    call(6, "resolve_performance_cycle", [
      leaveCycle.id,
      "close",
      "Close too early",
    ]),
  );
  await call(6, "resolve_performance_cycle", [
    leaveCycle.id,
    "cancel",
    "Checkpoint deferred to an agreed later cycle",
  ]);
  ok(
    "cycle cancellation preserves the checkpoint record",
    (await detail(7, leaveInstance.id)).status === "cancelled",
  );
  await denied("cancelled cycles cannot accept review submissions", async () =>
    save(
      7,
      (await detail(7, leaveInstance.id)).reviewers.find(
        (r) => r.role === "self",
      ).id,
      answers,
      0,
      true,
    ),
  );
  const emptyCycle = await make({
    name: "No eligible targets",
    employee_filter: { employee_ids: [emps[8], emps[9]] },
  });
  await denied(
    "cycles with no eligible staff cannot silently launch empty",
    () => call(6, "launch_appraisal_cycle", [emptyCycle.id]),
  );
  const ownHr = await make({
      name: "HR own checkpoint",
      employee_filter: { employee_ids: [emps[0]] },
    }),
    ownInstance = await call(0, "launch_appraisal_cycle", [ownHr.id]);
  const ownRecord = await detail(0, ownInstance.id),
    unassigned = ownRecord.reviewers.find((r) => r.role === "hr");
  ok(
    "HR cannot become their own independent reviewer",
    unassigned.reviewer_user_id === null,
  );
  await denied("HR cannot administer their own reviewer replacement", () =>
    call(0, "resolve_performance_reviewer", [
      unassigned.id,
      emps[6],
      "Assign another HR colleague",
      false,
    ]),
  );
  await call(6, "resolve_performance_reviewer", [
    unassigned.id,
    emps[6],
    "Independent HR colleague assigned",
    false,
  ]);
  ok(
    "another HR colleague can resolve a missing independent reviewer",
    (await detail(0, ownInstance.id)).reviewers.some(
      (r) =>
        r.role === "hr" &&
        r.reviewer_user_id === users[6] &&
        r.status === "pending",
    ),
  );
  const fallback = await make({
      name: "Unmanaged employee checkpoint",
      employee_filter: { employee_ids: [emps[4]] },
    }),
    fallbackI = await call(6, "launch_appraisal_cycle", [fallback.id]),
    fallbackRecord = await detail(4, fallbackI.id);
  ok(
    "employees without leaders retain an independent HR stage",
    fallbackRecord.reviewers.some(
      (r) => r.role === "hr" && r.reviewer_user_id === users[6],
    ),
  );
  await denied("the only independent review stage cannot be waived", () =>
    call(6, "resolve_performance_reviewer", [
      fallbackRecord.reviewers.find((r) => r.role === "hr").id,
      null,
      "Skip all oversight",
      true,
    ]),
  );
  const history = (await call(2, "list_employee_performance", [emps[1], 1]))
    .list_employee_performance;
  ok(
    "team checkpoint history correlates to the employee without exposing answer bodies",
    history.total === 1 &&
      history.items[0].id === iid &&
      !JSON.stringify(history).includes("Specific employee"),
  );
  await denied("unrelated staff cannot inspect another employee history", () =>
    call(4, "list_employee_performance", [emps[1], 1]),
  );
  await denied("foreign HR cannot inspect employee history", () =>
    call(5, "list_employee_performance", [emps[1], 1]),
  );
  await db.query(`update public.employees set user_id=null where id=$1`, [
    emps[9],
  ]);
  await denied(
    "an unlinked employee cannot bypass history authorization with a null user id",
    () => call(4, "list_employee_performance", [emps[9], 1]),
  );
  const nextDay = (
    await db.query(`select ($1::date+1)::text local_day`, [today])
  ).rows[0].local_day;
  const future = await make({
      name: "Future opening",
      start_date: nextDay,
      self_review_due: null,
      supervisor_review_due: null,
      manager_review_due: null,
      acknowledgement_due: null,
    }),
    futureI = await call(6, "launch_appraisal_cycle", [future.id]);
  const futureSelf = (await detail(1, futureI.id)).reviewers.find(
    (r) => r.role === "self",
  );
  await denied(
    "future cycles cannot be answered before their organization-local opening date",
    () => save(1, futureSelf.id, answers, 0, true),
  );
  const replacementCycle = await make({ name: "Reviewer recovery" }),
    replacementI = await call(6, "launch_appraisal_cycle", [
      replacementCycle.id,
    ]),
    recovery = await detail(1, replacementI.id);
  await save(
    1,
    recovery.reviewers.find((r) => r.role === "self").id,
    answers,
    0,
    true,
  );
  const oldSupervisor = recovery.reviewers.find((r) => r.role === "supervisor");
  await save(
    2,
    oldSupervisor.id,
    { ...answers, [q.text]: "Private reassignment draft" },
    0,
    false,
  );
  await db.query(
    `update public.role_assignments set role='employee' where user_id=$1 and organization_id=$2`,
    [users[2], ORG],
  );
  await denied(
    "revoked reviewer authority prevents a previously assigned draft save",
    () => save(2, oldSupervisor.id, answers, 1, false),
  );
  await db.query(
    `update public.role_assignments set role='supervisor' where user_id=$1 and organization_id=$2`,
    [users[2], ORG],
  );
  await denied("reassignment checks the replacement permission and scope", () =>
    call(6, "resolve_performance_reviewer", [
      oldSupervisor.id,
      emps[4],
      "Ineligible replacement",
      false,
    ]),
  );
  await call(6, "resolve_performance_reviewer", [
    oldSupervisor.id,
    emps[6],
    "Independent HR cover for absence",
    false,
  ]);
  const reassigned = await detail(2, replacementI.id);
  ok(
    "reassignment retains retired stages and hides their private drafts",
    reassigned.reviewers.find((r) => r.id === oldSupervisor.id).status ===
      "skipped" &&
      !reassigned.responses.some((a) => a.reviewer_id === oldSupervisor.id),
  );
  const currentReplacement = reassigned.reviewers.find(
    (r) => r.role === "supervisor" && r.status === "pending",
  );
  await call(6, "resolve_performance_reviewer", [
    currentReplacement.id,
    emps[2],
    "Original supervisor returned and can resume",
    false,
  ]);
  ok(
    "the same reviewer can return with a new stage while prior history is preserved",
    (await detail(2, replacementI.id)).reviewers.filter(
      (r) => r.role === "supervisor",
    ).length === 3,
  );
  await denied("a retired stage cannot be reassigned twice", () =>
    call(6, "resolve_performance_reviewer", [
      oldSupervisor.id,
      emps[6],
      "Retry retired reassignment",
      false,
    ]),
  );
  await db.exec(
    `insert into public.organization_network_policies(organization_id,enforcement_mode) values('${ORG}','enforced') on conflict(organization_id) do update set enforcement_mode='enforced';insert into public.organization_network_ranges(organization_id,cidr,label) values('${ORG}','192.0.2.0/24','Office');select set_config('request.headers','{"cf-connecting-ip":"203.0.113.9"}',false)`,
  );
  await denied("the existing network policy protects Performance reads", () =>
    detail(1, iid),
  );
  await db.exec(
    `select set_config('request.headers','{"cf-connecting-ip":"192.0.2.10"}',false)`,
  );
  ok(
    "allowed network access restores authorized Performance records",
    (await detail(1, iid)).status === "complete",
  );
  await db.exec(
    `select set_config('request.headers','{}',false);update public.organization_network_policies set enforcement_mode='disabled' where organization_id='${ORG}'`,
  );
  await db.exec(
    `insert into public.organization_security_policies(organization_id,mfa_policy) values('${ORG}','everyone') on conflict(organization_id) do update set mfa_policy='everyone';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("required MFA protects released performance details", () =>
    detail(1, iid),
  );
  await as(users[1], async () =>
    ok(
      "required MFA protects direct response reads",
      (
        await db.query(
          `select * from public.appraisal_responses where instance_id=$1`,
          [iid],
        )
      ).rows.length === 0,
    ),
  );
  await denied("required MFA protects cycle administration", () =>
    call(6, "get_performance_admin", [ORG, 1]),
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  ok(
    "verified MFA restores authorized performance history",
    (await detail(1, iid)).status === "complete",
  );
  await db.exec(
    `update public.organization_security_policies set mfa_policy='optional',step_up_for_sensitive_actions=true where organization_id='${ORG}';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("sensitive-action step-up protects cycle creation", () =>
    make({ name: "Blocked by step-up" }),
  );
  await denied(
    "sensitive-action step-up protects employee receipt retries",
    () => call(1, "record_performance_receipt", [iid, "received", null]),
  );
  await db.exec(
    `update public.organization_security_policies set step_up_for_sensitive_actions=false where organization_id='${ORG}';select set_config('request.jwt.claims','',false)`,
  );
  await denied("null personal view is rejected", () =>
    call(1, "list_performance_work", [ORG, null, 1]),
  );
  await denied("invalid administration pages are rejected", () =>
    call(6, "get_performance_admin", [ORG, 0]),
  );
  const notices = (
    await db.query(
      `select body,link_url from public.notifications where organization_id=$1 and type like 'performance.%'`,
      [ORG],
    )
  ).rows;
  ok(
    "notifications link to the record without copying review text",
    notices.length > 0 &&
      notices.every(
        (n) =>
          n.link_url.startsWith("/appraisals/") &&
          !String(n.body).includes("confidential working draft"),
      ),
  );
  const boundary = (
    await db.query(
      `select bool_and(not p.prosecdef and not has_function_privilege('anon',p.oid,'execute')) safe from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('launch_appraisal_cycle','submit_appraisal','acknowledge_appraisal','save_appraisal_review','get_performance_checkpoint','save_performance_cycle','update_performance_goal','add_performance_message')`,
    )
  ).rows[0];
  ok(
    "Performance APIs use invoker wrappers and deny anonymous execution",
    boundary.safe,
  );
}
