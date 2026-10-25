import { randomUUID } from "node:crypto";
export async function testRecognition({ db, as, ok }) {
  const ORG = "fd000000-0000-0000-0000-000000000001",
    OTHER = "fd000000-0000-0000-0000-000000000002";
  const users = Array.from(
      { length: 7 },
      (_, i) => `fd100000-0000-0000-0000-00000000000${i + 1}`,
    ),
    emps = Array.from(
      { length: 7 },
      (_, i) => `fd200000-0000-0000-0000-00000000000${i + 1}`,
    );
  const denied = async (label, fn) => {
    let rejected = false;
    try {
      await fn();
    } catch {
      rejected = true;
    }
    ok(label, rejected);
  };
  await db.exec(
    `insert into public.organizations(id,name,slug,timezone) values('${ORG}','Recognition HR','recognition-hr-tests','America/Jamaica'),('${OTHER}','Other Recognition','recognition-other-tests','UTC')`,
  );
  for (let i = 0; i < 7; i++)
    await db.exec(
      `insert into auth.users(id,email) values('${users[i]}','recognition-${i}@test.invalid');insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date) values('${emps[i]}','${i === 4 ? OTHER : ORG}','${users[i]}','REC-${i}','Recognition','Person ${i}','active','2020-01-01');${i === 6 ? "" : `insert into public.role_assignments(organization_id,user_id,role) values('${i === 4 ? OTHER : ORG}','${users[i]}','${i === 0 || i === 4 ? "admin" : "employee"}');`}`,
    );
  const custom = (
    await db.query(
      `insert into public.organization_roles(organization_id,name) values('${ORG}','Points awarder without private moderation') returning id`,
    )
  ).rows[0].id;
  await db.exec(
    `insert into public.role_permissions(organization_id,custom_role_id,permission) values('${ORG}','${custom}','rewards.award_points'),('${ORG}','${custom}','recognition.read');insert into public.role_assignments(organization_id,user_id,custom_role_id) values('${ORG}','${users[6]}','${custom}')`,
  );
  const values = (
    await db.query(
      `select id,name from public.recognition_values where organization_id='${ORG}' order by name`,
    )
  ).rows;
  ok(
    "new workspaces receive a usable set of recognition values",
    values.length === 4,
  );
  const value = values[0].id,
    foreignValue = (
      await db.query(
        `select id from public.recognition_values where organization_id='${OTHER}' limit 1`,
      )
    ).rows[0].id;
  const api = (
    await db.query(
      `select count(*) n,bool_and(not p.prosecdef and not has_function_privilege('anon',p.oid,'EXECUTE')) safe from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('give_recognition','send_recognition','get_recognition_state','search_recognition_coworkers','list_recognition_feed','set_recognition_preference','make_recognition_private','report_recognition','moderate_recognition','save_recognition_settings','save_recognition_value','recognition_health','redeem_reward','get_recognition','list_recognition_reports','commit_employee_import_batch')`,
    )
  ).rows[0];
  ok(
    "recognition and connected write APIs use invoker wrappers and deny anonymous calls",
    Number(api.n) === 16 && api.safe === true,
  );
  const send = async (
    giver = 1,
    {
      recipient = emps[2],
      message = "Thank you for resolving the customer issue thoughtfully.",
      valueId = value,
      points = 0,
      visibility = "public",
      key = randomUUID(),
      org = ORG,
    } = {},
  ) =>
    as(
      users[giver],
      async () =>
        (
          await db.query(
            `select * from public.send_recognition($1,$2,$3,$4,$5,$6,$7)`,
            [recipient, message, valueId, points, visibility, key, org],
          )
        ).rows[0],
    );
  const state = async (i) =>
    as(
      users[i],
      async () =>
        (await db.query(`select public.get_recognition_state('${ORG}') s`))
          .rows[0].s,
    );
  const feed = async (i, scope = "all", page = 1) =>
    as(
      users[i],
      async () =>
        (
          await db.query(
            `select public.list_recognition_feed('${ORG}','${scope}',${page}) f`,
          )
        ).rows[0].f,
    );
  const change = async (patch) =>
    as(users[0], async () => {
      const s = (
        await db.query(
          `select * from public.organization_recognition_settings where organization_id='${ORG}'`,
        )
      ).rows[0];
      return (
        await db.query(
          `select public.save_recognition_settings($1,$2::jsonb) s`,
          [ORG, JSON.stringify({ ...s, ...patch })],
        )
      ).rows[0].s;
    });
  await denied('recognition values cannot be duplicated with different casing',()=>as(users[0],()=>db.query(`select public.save_recognition_value($1,$2)`,[ORG,values[1].name.toUpperCase()])));
  await denied('point-bearing recognition cannot commit without its Rewards credit',()=>db.query(`insert into public.recognitions(organization_id,giver_employee_id,recipient_employee_id,message,points_given,visibility) values('${ORG}','${emps[1]}','${emps[2]}','Missing credit should roll back',2,'private')`));
  await denied('a recognition credit cannot be created without a source recognition',()=>db.query(`insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount) values('${ORG}','${emps[2]}','recognition',2)`));
  const first = await send();
  ok(
    "kudos work while the Rewards marketplace is disabled",
    first.points_given === 0,
  );
  await denied("points require an enabled Rewards program", () =>
    send(1, { points: 10 }),
  );
  await as(users[1], async () => {
    const coworkers = (
      await db.query(
        `select public.search_recognition_coworkers('${ORG}','REC-2') c`,
      )
    ).rows[0].c;
    ok(
      "coworker search works without full directory read access",
      coworkers.length === 1 && coworkers[0].id === emps[2],
    );
    ok(
      "coworker search exposes only necessary directory fields",
      !("work_email" in coworkers[0]) && !("user_id" in coworkers[0]),
    );
  });
  await denied("cross-organization recipients are rejected", () =>
    send(1, { recipient: emps[4] }),
  );
  await denied("cross-organization values are rejected", () =>
    send(1, { valueId: foreignValue }),
  );
  await denied("self recognition is rejected", () =>
    send(1, { recipient: emps[1] }),
  );
  await denied("blank messages are rejected", () =>
    send(1, { message: "   " }),
  );
  await denied("overlong messages are rejected", () =>
    send(1, { message: "a".repeat(501) }),
  );
  await denied("negative points are rejected", () => send(1, { points: -1 }));
  await denied("invalid audience is rejected", () =>
    send(1, { visibility: "world" }),
  );
  await db.exec(
    `insert into public.organization_feature_overrides(organization_id,feature_key,enabled) values('${ORG}','rewards_marketplace',true)`,
  );
  await change({
    monthly_point_allowance: 100,
    max_points_per_recognition: 50,
    max_recognitions_per_day_per_giver: 100,
    max_points_per_recipient_per_month: 60,
  });
  const key = randomUUID(),
    pointsRecord = await send(1, { points: 20, visibility: "private", key });
  const retry = await send(1, { points: 20, visibility: "private", key });
  ok(
    "a send retry returns the original recognition",
    retry.id === pointsRecord.id,
  );
  ok(
    "a send retry credits Rewards only once",
    Number(
      (
        await db.query(
          `select count(*) n from public.employee_points_ledger where related_recognition_id='${pointsRecord.id}'`,
        )
      ).rows[0].n,
    ) === 1,
  );
  await denied("a retry key cannot be reused with different contents", () =>
    send(1, { points: 21, visibility: "private", key }),
  );
  await denied("per-recognition points cap is enforced", () =>
    send(1, { points: 51 }),
  );
  await denied("per-recipient monthly points cap is enforced", () =>
    send(1, { points: 41 }),
  );
  await change({
    max_points_per_recognition: 80,
    max_points_per_recipient_per_month: null,
  });
  await send(1, { recipient: emps[3], points: 80 });
  await denied("monthly giver allowance cannot be exceeded", () =>
    send(1, { points: 1 }),
  );
  ok(
    "giving allowance is independent from the giver Rewards balance",
    (await state(1)).remaining_points === 0 &&
      (await state(1)).points_balance === 0,
  );
  await as(users[3], async () => {
    ok(
      "an uninvolved peer cannot read private recognition",
      (
        await db.query(
          `select id from public.recognitions where id='${pointsRecord.id}'`,
        )
      ).rows.length === 0,
    );
    await denied(
      "private recognition cannot be opened through a guessed link",
      () => db.query(`select public.get_recognition('${pointsRecord.id}')`),
    );
  });
  await as(users[6], async () => {
    ok(
      "points award permission alone does not grant private recognition access",
      (
        await db.query(
          `select id from public.recognitions where id='${pointsRecord.id}'`,
        )
      ).rows.length === 0,
    );
    await denied("points awarder cannot review private reports", () =>
      db.query(`select public.list_recognition_reports('${ORG}')`),
    );
  });
  await as(users[0], async () => {
    ok(
      "authorized moderators can read private recognition",
      (
        await db.query(
          `select id from public.recognitions where id='${pointsRecord.id}'`,
        )
      ).rows.length === 1,
    );
  });
  await as(users[2], async () => {
    const n = (
      await db.query(
        `select body,data from public.notifications where recipient_user_id='${users[2]}' and type='recognition.received'`,
      )
    ).rows;
    ok(
      "notification bodies omit recognition message content",
      n.length > 0 && n.every((x) => !x.body.includes("customer issue")),
    );
  });
  await as(users[3], async () => {
    ok(
      "public recognition is visible to an eligible coworker",
      (
        await db.query(
          `select id from public.recognitions where id='${first.id}'`,
        )
      ).rows.length === 1,
    );
  });
  await as(users[2], () =>
    db.query(`select public.make_recognition_private('${first.id}')`),
  );
  await as(users[3], async () => {
    ok(
      "recipient can remove an earlier public message from the feed",
      (
        await db.query(
          `select id from public.recognitions where id='${first.id}'`,
        )
      ).rows.length === 0,
    );
  });
  await denied("a giver cannot override the recipient audience", () =>
    as(users[1], () =>
      db.query(`select public.make_recognition_private('${first.id}')`),
    ),
  );
  const anotherPublic = await send(3, { recipient: emps[2] });
  await as(users[2], () =>
    db.query(`select public.set_recognition_preference('${ORG}',false)`),
  );
  ok(
    "private preference converts earlier public recognition",
    (
      await db.query(
        `select visibility from public.recognitions where id='${anotherPublic.id}'`,
      )
    ).rows[0].visibility === "private",
  );
  const forcedPrivate = await send(3, {
    recipient: emps[2],
    visibility: "public",
  });
  ok(
    "recipient preference overrides public posting requests",
    forcedPrivate.visibility === "private",
  );
  await as(users[2], () =>
    db.query(`select public.set_recognition_preference('${ORG}',true)`),
  );
  ok(
    "reenabling public recognition does not republish earlier private messages",
    (
      await db.query(
        `select visibility from public.recognitions where id='${forcedPrivate.id}'`,
      )
    ).rows[0].visibility === "private",
  );
  await denied("private messages cannot be made public by a direct write", () =>
    db.query(
      `update public.recognitions set visibility='public' where id='${forcedPrivate.id}'`,
    ),
  );
  await denied("recognition message and award amount are immutable", () =>
    db.query(
      `update public.recognitions set message='changed' where id='${first.id}'`,
    ),
  );
  await denied("recognition cannot be deleted", () =>
    db.query(`delete from public.recognitions where id='${first.id}'`),
  );
  await denied("Rewards ledger entries cannot be overwritten", () =>
    db.query(
      `update public.employee_points_ledger set amount=999 where related_recognition_id='${pointsRecord.id}'`,
    ),
  );
  await denied("recognition ledger credit cannot be duplicated", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,related_recognition_id) values('${ORG}','${emps[2]}','recognition',20,'${pointsRecord.id}')`,
    ),
  );
  await as(users[0], () =>
    db.query(
      `select public.save_recognition_value('${ORG}','Renamed value','Clear behavior description','${value}',true)`,
    ),
  );
  ok(
    "historical value labels remain unchanged after renaming",
    (
      await db.query(
        `select value_name from public.recognitions where id='${first.id}'`,
      )
    ).rows[0].value_name === values[0].name,
  );
  await db.exec(
    `update public.recognition_values set is_active=false where id='${value}'`,
  );
  await denied("archived values cannot be used for a new recognition", () =>
    send(3),
  );
  await change({ require_value: true });
  await denied("required organization value cannot be omitted", () =>
    send(3, { valueId: null }),
  );
  await change({ require_value: false });
  for (const status of ["prehire", "suspended", "terminated"]) {
    await db.exec(
      `update public.employees set status='${status}' where id='${emps[5]}'`,
    );
    await denied(`${status} employees cannot give recognition`, () =>
      send(5, { valueId: null }),
    );
    await denied(`${status} employees cannot receive recognition`, () =>
      send(3, { recipient: emps[5], valueId: null }),
    );
  }
  await db.exec(
    `update public.employees set status='leave',preferred_name='Rae' where id='${emps[5]}'`,
  );
  const leaveRecord = await send(5, { valueId: null });
  ok(
    "employees on leave remain eligible for recognition",
    leaveRecord.id != null,
  );
  await db.exec(
    `update public.employees set status='active' where id='${emps[5]}'`,
  );
  ok(
    "recognition uses the employee preferred name",
    leaveRecord.giver_name.startsWith("Rae "),
  );
  const report = await as(
    users[2],
    async () =>
      (
        await db.query(
          `select public.report_recognition('${pointsRecord.id}','Please review the award and supporting message.') id`,
        )
      ).rows[0].id,
  );
  const reportRetry = await as(
    users[2],
    async () =>
      (
        await db.query(
          `select public.report_recognition('${pointsRecord.id}','Please review the award and supporting message.') id`,
        )
      ).rows[0].id,
  );
  ok(
    "repeated reporting does not duplicate an open concern",
    reportRetry === report,
  );
  await as(users[3], async () => {
    ok(
      "reporter identity and reasons are hidden from other employees",
      (
        await db.query(
          `select id from public.recognition_reports where id='${report}'`,
        )
      ).rows.length === 0,
    );
  });
  await denied("a null moderation action cannot close reports", () =>
    as(users[0], () =>
      db.query(
        `select public.moderate_recognition('${pointsRecord.id}',null,'This is an invalid moderation action')`,
      ),
    ),
  );
  await denied("employees cannot moderate recognition or reverse points", () =>
    as(users[2], () =>
      db.query(
        `select public.moderate_recognition('${pointsRecord.id}','remove','I want to remove the recognition')`,
      ),
    ),
  );
  await denied("another tenant cannot moderate recognition", () =>
    as(users[4], () =>
      db.query(
        `select public.moderate_recognition('${pointsRecord.id}','remove','I belong to another organization')`,
      ),
    ),
  );
  // Spend the attached points, then remove the recognition and refund the pending reward.
  const provider = (
      await db.query(
        `select id from public.reward_providers where key='manual'`,
      )
    ).rows[0].id,
    vendor = (
      await db.query(
        `insert into public.reward_vendors(organization_id,provider_id,name) values('${ORG}','${provider}','Recognition Test Vendor') returning id`,
      )
    ).rows[0].id;
  const product = (
    await db.query(
      `insert into public.reward_products(organization_id,vendor_id,name,points_cost,inventory_quantity) values('${ORG}','${vendor}','Recognition Test Reward',20,1) returning id`,
    )
  ).rows[0].id;
  const redemption = await as(
    users[2],
    async () =>
      (await db.query(`select * from public.redeem_reward('${product}')`))
        .rows[0],
  );
  ok(
    "recognition points can fund an authorized Rewards redemption",
    redemption.points_spent === 20,
  );
  await as(users[0], () =>
    db.query(
      `select public.moderate_recognition('${pointsRecord.id}','remove','Award was issued for the wrong contribution.')`,
    ),
  );
  await as(users[0], () =>
    db.query(
      `select public.moderate_recognition('${pointsRecord.id}','remove','Award was issued for the wrong contribution.')`,
    ),
  );
  ok(
    "moderation reverses the original award exactly once",
    Number(
      (
        await db.query(
          `select count(*) n,sum(amount) amount from public.employee_points_ledger where related_recognition_id='${pointsRecord.id}' and entry_type='recognition_reversal'`,
        )
      ).rows[0].n,
    ) === 1,
  );
  ok(
    "spent recognition points remain accounted for through a negative balance",
    (await state(2)).points_balance === -20,
  );
  ok(
    "removing recognition does not replenish the giver allowance",
    (await state(1)).remaining_points === 0,
  );
  await as(users[2], async () => {
    const detail = (
      await db.query(`select public.get_recognition('${pointsRecord.id}') r`)
    ).rows[0].r;
    ok(
      "removed recognition link gives a safe status without the removed message",
      detail.status === "removed" && detail.message === null,
    );
    ok(
      "raw removed content is unavailable to participants",
      (
        await db.query(
          `select id from public.recognitions where id='${pointsRecord.id}'`,
        )
      ).rows.length === 0,
    );
    const reports = (
      await db.query(
        `select public.list_recognition_reports('${ORG}','all',1,true) r`,
      )
    ).rows[0].r;
    ok(
      "reporter can see the recorded HR decision",
      reports.total === 1 &&
        reports.items[0].status === "resolved" &&
        !!reports.items[0].resolution,
    );
  });
  await db.exec(
    `update public.reward_products set inventory_quantity=1 where id='${product}'`,
  );
  await denied("negative point balances cannot fund another reward", () =>
    as(users[2], () => db.query(`select public.redeem_reward('${product}')`)),
  );
  await as(users[0], () =>
    db.query(
      `select public.cancel_redemption('${redemption.id}','Canceled after HR recognition review')`,
    ),
  );
  ok(
    "refund and recognition reversal reconcile without creating extra points",
    (await state(2)).points_balance === 0,
  );
  await denied("removed recognition cannot be restored and paid twice", () =>
    db.query(
      `update public.recognitions set status='active' where id='${pointsRecord.id}'`,
    ),
  );
  await denied("moderation evidence cannot be edited", () =>
    db.query(
      `update public.recognition_moderation_events set reason='different' where recognition_id='${pointsRecord.id}'`,
    ),
  );
  await denied(
    "ordinary employees cannot read program health/private totals",
    () =>
      as(users[3], () =>
        db.query(
          `select public.recognition_health('${ORG}',current_date-31,current_date+1)`,
        ),
      ),
  );
  await as(users[0], async () => {
    const health = (
      await db.query(
        `select public.recognition_health('${ORG}',current_date-31,current_date+1) h`,
      )
    ).rows[0].h;
    ok(
      "HR health reports reconcile active and removed points",
      health.removed === 1 &&
        health.points_reversed === 20 &&
        health.open_reports === 0,
    );
  });
  await change({ enabled: false });
  await denied("pausing recognition prevents new posts", () =>
    send(3, { valueId: null }),
  );
  ok("pausing does not hide recognition history", (await feed(3)).total > 0);
  await change({ enabled: true });
  await db.exec(
    `update public.organization_feature_overrides set enabled=false where organization_id='${ORG}' and feature_key='rewards_marketplace'`,
  );
  await as(users[0], async () => {
    ok(
      "recognition administration remains usable without Rewards",
      (await db.query(`select public.get_recognition_state('${ORG}') s`))
        .rows[0].s.can_manage === true,
    );
  });
  await denied("redemption cannot bypass a disabled Rewards feature", () =>
    as(users[3], () => db.query(`select public.redeem_reward('${product}')`)),
  );
  await db.exec(
    `insert into public.organization_security_policies(organization_id,mfa_policy) values('${ORG}','everyone') on conflict(organization_id) do update set mfa_policy='everyone';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("required MFA protects recognition state RPC", () => state(1));
  await as(users[2], async () => {
    ok(
      "required MFA protects direct recognition reads",
      (
        await db.query(
          `select id from public.recognitions where organization_id='${ORG}'`,
        )
      ).rows.length === 0,
    );
  });
  await denied("required MFA protects report and moderation reads", () =>
    as(users[0], () =>
      db.query(`select public.list_recognition_reports('${ORG}')`),
    ),
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  ok(
    "verified MFA restores authorized recognition access",
    (await state(1)).can_give === true,
  );
  await db.exec(
    `update public.organization_security_policies set mfa_policy='optional' where organization_id='${ORG}';select set_config('request.jwt.claims','',false)`,
  );
  await db.exec(
    `update public.organization_feature_overrides set enabled=true where organization_id='${ORG}' and feature_key='rewards_marketplace';update public.organization_security_policies set step_up_for_sensitive_actions=true where organization_id='${ORG}';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied(
    "points-based recognition obeys the sensitive-action step-up policy",
    () => send(5, { valueId: null, points: 1 }),
  );
  ok(
    "kudos do not require sensitive-action step-up when ordinary MFA is optional",
    !!(await send(5, { valueId: null })).id,
  );
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  ok(
    "verified step-up permits an otherwise valid points recognition",
    !!(await send(5, { valueId: null, points: 1 })).id,
  );
  await db.exec(
    `update public.organization_security_policies set step_up_for_sensitive_actions=false where organization_id='${ORG}';select set_config('request.jwt.claims','',false)`,
  );
  // Test day/month boundaries against organization-local timestamps, not machine timezone.
  await change({
    max_recognitions_per_day_per_giver: 1,
    monthly_point_allowance: 10,
  });
  await db.exec(
    `update public.organizations set timezone=case when extract(hour from now() at time zone 'UTC')<12 then 'Etc/GMT+12' else 'Pacific/Kiritimati' end where id='${ORG}'`,
  );
  const boundary = (
    await db.query(
      `select private.org_today('${ORG}')<>(now() at time zone 'UTC')::date as different,(private.org_today('${ORG}')::timestamp at time zone o.timezone-interval '1 second') as prior_day,(date_trunc('month',now() at time zone o.timezone) at time zone o.timezone-interval '1 second') as prior_month from public.organizations o where id='${ORG}'`,
    )
  ).rows[0];
  ok(
    "recognition boundary fixture differs from the UTC date",
    boundary.different === true,
  );
  await as(users[3], async () => {
    await denied("null feed scope is rejected", () =>
      db.query(`select public.list_recognition_feed('${ORG}',null)`),
    );
    await denied("null report owner scope is rejected", () =>
      db.query(`select public.list_recognition_reports('${ORG}','all',1,null)`),
    );
  });
  const past = randomUUID();
  await db.exec(
    `begin;insert into public.recognitions(id,organization_id,giver_employee_id,recipient_employee_id,message,points_given,visibility,created_at) values('${past}','${ORG}','${emps[6]}','${emps[3]}','Previous month recognition',7,'public','${new Date(boundary.prior_month).toISOString()}');insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,related_recognition_id) values('${ORG}','${emps[3]}','recognition',7,'${past}');commit;`,
  );
  // Earlier leaveRecord was created today: temporarily use a fresh eligible giver for the cap.
  await db.exec(
    `insert into public.role_permissions(organization_id,custom_role_id,permission) values('${ORG}','${custom}','recognition.give')`,
  );
  ok(
    "local monthly allowance excludes previous-month recognition",
    (await state(6)).remaining_points === 10,
  );
  await send(6, { valueId: null });
  await denied("daily cap counts kudos-only recognition", () =>
    send(6, { valueId: null }),
  );
  ok(
    "daily remaining count matches the enforcement counter",
    (await state(6)).daily_remaining === 0,
  );
  // Independent read permission keeps received history available after giving is revoked.
  await db.exec(
    `insert into public.role_permissions(organization_id,role,permission) select '${ORG}',role,permission from public.role_permissions where organization_id is null and role='employee';delete from public.role_permissions where organization_id='${ORG}' and role='employee' and permission='recognition.give'`,
  );
  await denied("revoking give permission blocks posting", () =>
    send(3, { valueId: null }),
  );
  ok("read permission survives giving revocation", (await feed(3)).total > 0);
  await db.exec(
    `delete from public.role_permissions where organization_id='${ORG}' and role='employee' and permission='recognition.read'`,
  );
  await denied("revoking recognition read permission blocks feed access", () =>
    feed(3),
  );
  await as(users[3], async () => {
    ok(
      "recognition read revocation also blocks direct table access",
      (
        await db.query(
          `select id from public.recognitions where organization_id='${ORG}'`,
        )
      ).rows.length === 0,
    );
  });
}
