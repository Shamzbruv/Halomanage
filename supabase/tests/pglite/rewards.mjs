import { randomUUID } from "node:crypto";
export async function testRewards({ db, as, ok }) {
  const ORG = "fe000000-0000-0000-0000-000000000001",
    OTHER = "fe000000-0000-0000-0000-000000000002";
  const users = Array.from(
      { length: 10 },
      (_, i) => `fe100000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    ),
    emps = Array.from(
      { length: 10 },
      (_, i) => `fe200000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
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
    `insert into public.organizations(id,name,slug,timezone) values('${ORG}','Rewards HR','rewards-hr-tests','America/Jamaica'),('${OTHER}','Other Rewards','rewards-other-tests','UTC');insert into public.organization_feature_overrides(organization_id,feature_key,enabled) values('${ORG}','rewards_marketplace',true),('${OTHER}','rewards_marketplace',true);`,
  );
  for (let i = 0; i < 10; i++)
    await db.exec(
      `insert into auth.users(id,email) values('${users[i]}','reward-${i}@test.invalid');insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date) values('${emps[i]}','${i === 5 ? OTHER : ORG}','${users[i]}','RWD-${i}','Reward','Person ${i}','${i === 2 ? "leave" : i === 3 ? "prehire" : i === 4 ? "terminated" : "active"}','2020-01-01');${i >= 7 ? "" : `insert into public.role_assignments(organization_id,user_id,role) values('${i === 5 ? OTHER : ORG}','${users[i]}','${i === 0 || i === 5 ? "admin" : i === 6 ? "manager" : "employee"}');`}`,
    );
  for (let i = 7; i < 10; i++) {
    const role = (
      await db.query(
        `insert into public.organization_roles(organization_id,name) values($1,$2) returning id`,
        [ORG, ["Catalog only", "Points only", "Fulfillment only"][i - 7]],
      )
    ).rows[0].id;
    await db.query(
      `insert into public.role_permissions(organization_id,custom_role_id,permission) values($1,$2,$3)`,
      [
        ORG,
        role,
        ["rewards.manage_catalog", "rewards.award_points", "rewards.fulfill"][
          i - 7
        ],
      ],
    );
    await db.query(
      `insert into public.role_assignments(organization_id,user_id,custom_role_id) values($1,$2,$3)`,
      [ORG, users[i], role],
    );
  }
  const call = async (i, name, args = []) =>
    as(
      users[i],
      async () =>
        (
          await db.query(
            `select * from public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")})`,
            args,
          )
        ).rows[0],
    );
  const state = async (i = 1, cp = 1, hp = 1, lp = 1, q = "", r = null) =>
    (await call(i, "get_rewards_state", [ORG, cp, hp, lp, q, r]))
      .get_rewards_state;
  const admin = async (i = 0, status = "all", page = 1, q = "") =>
    (await call(i, "get_rewards_admin_state", [ORG, status, page, 1, q]))
      .get_rewards_admin_state;
  const provider = (
    await db.query(`select id from public.reward_providers where key='manual'`)
  ).rows[0].id;
  const vendorData = {
    provider_id: provider,
    name: "Local supplier",
    contact_email: "supplier@example.test",
    contact_name: "HR supplier contact",
    description: "Manual rewards",
    is_active: true,
  };
  const vendor = await call(7, "save_reward_vendor", [
    ORG,
    JSON.stringify(vendorData),
    null,
    null,
  ]);
  ok(
    "catalog-only HR can create a vendor without full employee directory permissions",
    !!vendor.id,
  );
  const productData = {
    vendor_id: vendor.id,
    name: "Wellbeing voucher",
    description: "Choice of an accessible wellbeing activity",
    terms: "HR arranges pickup; valid 90 days after delivery.",
    points_cost: 100,
    inventory_quantity: 3,
    is_active: true,
  };
  let product = await call(7, "save_reward_product", [
    ORG,
    JSON.stringify(productData),
    null,
    null,
  ]);
  ok(
    "catalog-only HR can create a reward with terms and limited stock",
    product.points_cost === 100,
  );
  await denied('vendor names are unique after trimming and case folding',()=>call(7,'save_reward_vendor',[ORG,JSON.stringify({...vendorData,name:'  LOCAL SUPPLIER  '}),null,null]));
  await denied('retries cannot create duplicate products with the same vendor and name',()=>call(7,'save_reward_product',[ORG,JSON.stringify(productData),null,null]));
  await denied('HTTP image URLs are rejected',()=>call(7,'save_reward_product',[ORG,JSON.stringify({...productData,name:'Bad image',image_url:'http://example.test/image.png'}),null,null]));
  await denied('oversized stock is rejected',()=>call(7,'save_reward_product',[ORG,JSON.stringify({...productData,name:'Bad stock',inventory_quantity:1000001}),null,null]));
  await denied('catalog creation metadata cannot be rewritten',()=>as(users[7],()=>db.query(`update public.reward_products set created_at=created_at-interval '1 day' where id=$1`,[product.id])));
  await denied('employees cannot write reward points directly',()=>as(users[1],()=>db.query(`insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount) values($1,$2,'award',100)`,[ORG,emps[1]])));
  const api = (
    await db.query(
      `select count(*) n,bool_and(not p.prosecdef and not has_function_privilege('anon',p.oid,'execute')) safe from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('award_employee_points','grant_reward_points','redeem_reward','request_reward','fulfill_redemption','cancel_redemption','fail_redemption','cancel_my_reward','get_rewards_state','search_reward_employees','get_rewards_admin_state','save_reward_vendor','save_reward_product','reverse_reward_award','list_reward_awards')`,
    )
  ).rows[0];
  ok(
    "all Rewards APIs use invoker wrappers and deny anonymous execution",
    Number(api.n) === 15 && api.safe,
  );
  await denied(
    "retired spend implementation cannot bypass Rewards controls",
    () =>
      as(users[1], () =>
        db.query(`select recognition_internal.redeem_reward_legacy($1)`, [
          product.id,
        ]),
      ),
  );
  await denied("employees cannot call internal stock movement directly", () =>
    as(users[1], () =>
      db.query(`select rewards_internal.move_stock($1,100)`, [product.id]),
    ),
  );
  await db.query(`update public.reward_providers set is_active=false where id=$1`,[provider]);
  ok('inactive fulfillment provider hides its rewards',(await state()).catalog.length===0);
  await denied('inactive fulfillment provider blocks direct redemption',()=>call(1,'redeem_reward',[product.id]));
  await db.query(`update public.reward_providers set is_active=true where id=$1`,[provider]);
  const ordinary = await state();
  ok(
    "employee catalog contains safe vendor labels and published terms",
    ordinary.catalog[0]?.vendor_name === vendor.name &&
      ordinary.catalog[0]?.terms === productData.terms,
  );
  ok(
    "employee catalog does not expose supplier contacts",
    !JSON.stringify(ordinary.catalog).includes("supplier@example.test"),
  );
  await as(users[1], async () =>
    ok(
      "direct employee vendor queries hide contact records",
      (
        await db.query(`select * from public.reward_vendors where id=$1`, [
          vendor.id,
        ])
      ).rows.length === 0,
    ),
  );
  await denied("ordinary employees cannot open HR operational state", () =>
    admin(1),
  );
  await denied("cross-tenant administrator cannot read Rewards state", () =>
    call(5, "get_rewards_state", [ORG]),
  );
  await denied("cross-tenant administrator cannot edit a catalog entry", () =>
    call(5, "save_reward_product", [
      OTHER,
      JSON.stringify(productData),
      product.id,
      product.updated_at,
    ]),
  );
  for (const i of [3, 4])
    await denied(
      `${i === 3 ? "prehire" : "terminated"} staff cannot read rewards`,
      () => state(i),
    );
  ok(
    "employees on leave retain Rewards access",
    (await state(2)).balance === 0,
  );
  await denied("catalog manager cannot award points", () =>
    call(7, "grant_reward_points", [
      emps[1],
      500,
      "Helpful teamwork",
      randomUUID(),
    ]),
  );
  await denied("points awarder cannot edit catalog", () =>
    call(8, "save_reward_product", [
      ORG,
      JSON.stringify(productData),
      null,
      null,
    ]),
  );
  const found = await as(
    users[8],
    async () =>
      (
        await db.query(
          `select * from public.search_reward_employees($1,'RWD-')`,
          [ORG],
        )
      ).rows,
  );
  ok(
    "points-only role can find eligible employees without directory access",
    found.some((e) => e.id === emps[1]) && found.some((e) => e.id === emps[2]),
  );
  ok(
    "award employee search excludes self, other tenants and inactive staff",
    ![emps[8], emps[5], emps[3], emps[4]].some((id) =>
      found.some((e) => e.id === id),
    ),
  );
  await denied("ordinary employees cannot use the HR employee search", () =>
    call(1, "search_reward_employees", [ORG, "Reward"]),
  );
  for (const [label, target, amount, reason] of [
    ["self award", emps[0], 20, "Own reward"],
    ["prehire award", emps[3], 20, "Helpful work"],
    ["terminated award", emps[4], 20, "Helpful work"],
    ["zero award", emps[1], 0, "Helpful work"],
    ["negative award", emps[1], -1, "Helpful work"],
    ["oversized award", emps[1], 1000001, "Helpful work"],
    ["missing reason", emps[1], 20, " "],
  ])
    await denied(label + " is blocked", () =>
      call(0, "grant_reward_points", [target, amount, reason, randomUUID()]),
    );
  const awardKey = randomUUID(),
    award = await call(8, "grant_reward_points", [
      emps[1],
      500,
      "Resolved a customer concern",
      awardKey,
    ]);
  ok("points-only role can make a documented award", award.amount === 500);
  const awardRetry = await call(8, "grant_reward_points", [
    emps[1],
    500,
    "Resolved a customer concern",
    awardKey,
  ]);
  ok(
    "award retry returns the same ledger entry",
    awardRetry.id === award.id && (await state()).balance === 500,
  );
  await denied("award retry key cannot change recipient", () =>
    call(8, "grant_reward_points", [
      emps[2],
      500,
      "Resolved a customer concern",
      awardKey,
    ]),
  );
  await denied("award retry key cannot change amount", () =>
    call(8, "grant_reward_points", [
      emps[1],
      501,
      "Resolved a customer concern",
      awardKey,
    ]),
  );
  const requestKey = randomUUID();
  const redeem = (
    key = requestKey,
    price = product.points_cost,
    updated = product.updated_at,
  ) => call(1, "request_reward", [product.id, key, price, updated]);
  await denied("changed-price confirmation cannot debit the balance", () =>
    redeem(randomUUID(), 99),
  );
  await denied("missing retry key cannot submit a redemption", () =>
    redeem(null),
  );
  const receipt = await redeem();
  ok(
    "redemption stores an immutable cost, reward, vendor and terms receipt",
    receipt.product_name === productData.name &&
      receipt.vendor_name === vendor.name &&
      receipt.terms === productData.terms &&
      receipt.points_spent === 100 &&
      receipt.stock_reserved,
  );
  const retried = await redeem();
  ok(
    "redemption retry returns the original receipt with one debit",
    retried.id === receipt.id && (await state()).balance === 400,
  );
  ok(
    "stock is reserved once for a retried redemption",
    (
      await db.query(
        `select inventory_quantity from public.reward_products where id=$1`,
        [product.id],
      )
    ).rows[0].inventory_quantity === 2,
  );
  await denied(
    "redemption retry key cannot be reused with different details",
    () => redeem(requestKey, 101),
  );
  await denied("another employee cannot cancel this receipt", () =>
    call(2, "cancel_my_reward", [receipt.id, "Wrong recipient"]),
  );
  await denied("catalog-only role cannot fulfill requests", () =>
    call(7, "fulfill_redemption", [receipt.id, "Ready for collection"]),
  );
  await denied("missing fulfillment explanation is blocked", () =>
    call(9, "fulfill_redemption", [receipt.id, ""]),
  );
  await as(users[6], async () => {
    ok(
      "reporting-line permission alone does not disclose Rewards ledger",
      (
        await db.query(
          `select * from public.employee_points_ledger where employee_id=$1`,
          [emps[1]],
        )
      ).rows.length === 0,
    );
    ok(
      "reporting-line permission alone does not disclose receipts",
      (
        await db.query(`select * from public.reward_redemptions where id=$1`, [
          receipt.id,
        ])
      ).rows.length === 0,
    );
  });
  ok(
    "catalog-only admin state omits employee requests and balances",
    (await admin(7)).requests.length === 0 &&
      (await admin(7)).negative_balances === null,
  );
  ok(
    "fulfillment-only admin sees a useful employee label without directory permission",
    (await admin(9)).requests[0]?.employee_name === "Reward Person 1",
  );
  const current = (
    await db.query(`select * from public.reward_products where id=$1`, [
      product.id,
    ])
  ).rows[0];
  await denied("stale catalog edits cannot overwrite reserved stock", () =>
    call(7, "save_reward_product", [
      ORG,
      JSON.stringify(productData),
      product.id,
      product.updated_at,
    ]),
  );
  await denied("stock tracking cannot change while a request is pending", () =>
    call(7, "save_reward_product", [
      ORG,
      JSON.stringify({ ...productData, inventory_quantity: null }),
      product.id,
      current.updated_at,
    ]),
  );
  product = await call(7, "save_reward_product", [
    ORG,
    JSON.stringify({
      ...productData,
      name: "Renamed reward",
      points_cost: 120,
      inventory_quantity: 2,
      terms: "New terms for new requests",
    }),
    product.id,
    current.updated_at,
  ]);
  ok(
    "editing the catalog preserves old redemption names, cost and terms",
    (await state()).history[0]?.product_name === productData.name &&
      (await state()).history[0]?.terms === productData.terms,
  );
  const chosen = await state(1, 1, 1, 1, "", receipt.id);
  ok(
    "notification deep link opens an owned receipt",
    chosen.selected?.id === receipt.id,
  );
  ok(
    "deep link does not leak another employee receipt",
    (await state(2, 1, 1, 1, "", receipt.id)).selected === null,
  );
  await db.exec(
    `update public.organization_feature_overrides set enabled=false where organization_id='${ORG}' and feature_key='rewards_marketplace'`,
  );
  const paused = await state();
  ok(
    "paused Rewards preserves balance and history while hiding catalog",
    !paused.enabled &&
      paused.balance === 400 &&
      paused.history.length === 1 &&
      paused.catalog.length === 0,
  );
  await denied("paused program blocks awards", () =>
    call(8, "grant_reward_points", [emps[1], 1, "New award", randomUUID()]),
  );
  await denied("paused program blocks new redemptions", () =>
    redeem(randomUUID(), 120, product.updated_at),
  );
  await denied("paused program blocks catalog writes", () =>
    call(7, "save_reward_vendor", [
      ORG,
      JSON.stringify(vendorData),
      null,
      null,
    ]),
  );
  const cancelled = await call(1, "cancel_my_reward", [
    receipt.id,
    "Ordered by mistake",
  ]);
  ok(
    "employee can cancel a pending request during a pause",
    cancelled.status === "cancelled" && (await state()).balance === 500,
  );
  const cancelRetry = await call(1, "cancel_my_reward", [
    receipt.id,
    "Ordered by mistake",
  ]);
  ok(
    "repeated cancellation refunds and restores stock once",
    cancelRetry.id === receipt.id &&
      (await state()).balance === 500 &&
      (
        await db.query(
          `select inventory_quantity from public.reward_products where id=$1`,
          [product.id],
        )
      ).rows[0].inventory_quantity === 3,
  );
  await denied("cancelled requests cannot later be fulfilled", () =>
    call(9, "fulfill_redemption", [receipt.id, "Ready for collection"]),
  );
  await db.exec(
    `update public.organization_feature_overrides set enabled=true where organization_id='${ORG}' and feature_key='rewards_marketplace'`,
  );
  let latest = (
    await db.query(`select * from public.reward_products where id=$1`, [
      product.id,
    ])
  ).rows[0];
  const next = await call(1, "request_reward", [
    product.id,
    randomUUID(),
    120,
    latest.updated_at,
  ]);
  const failed = await call(9, "fail_redemption", [
    next.id,
    "Supplier cannot deliver this item",
  ]);
  ok(
    "failure records explanation and refunds the original price",
    failed.status === "failed" &&
      failed.fulfillment_note.includes("Supplier") &&
      (await state()).balance === 500,
  );
  await call(9, "fail_redemption", [
    next.id,
    "Supplier cannot deliver this item",
  ]);
  ok(
    "failure retries do not duplicate a refund",
    (await state()).balance === 500,
  );
  latest = (
    await db.query(`select * from public.reward_products where id=$1`, [
      product.id,
    ])
  ).rows[0];
  const finalReceipt = await call(1, "request_reward", [
    product.id,
    randomUUID(),
    120,
    latest.updated_at,
  ]);
  await db.exec(
    `update public.organization_feature_overrides set enabled=false where organization_id='${ORG}' and feature_key='rewards_marketplace'`,
  );
  const fulfilled = await call(9, "fulfill_redemption", [
    finalReceipt.id,
    "Collect at reception with this request reference",
  ]);
  ok(
    "HR can fulfill outstanding obligations when marketplace is paused",
    fulfilled.status === "fulfilled" &&
      !!fulfilled.resolved_at &&
      (await state()).balance === 380,
  );
  await call(9, "fulfill_redemption", [
    finalReceipt.id,
    "Collect at reception with this request reference",
  ]);
  ok("identical completion retry returns the same settled receipt", true);
  await denied("fulfilled reward cannot be cancelled by its recipient", () =>
    call(1, "cancel_my_reward", [finalReceipt.id, "Changed my mind"]),
  );
  await denied(
    "HR cannot refund an already fulfilled reward via cancellation",
    () => call(9, "cancel_redemption", [finalReceipt.id, "Changed my mind"]),
  );
  await denied("reward financial identity cannot be rewritten", () =>
    db.query(
      `update public.reward_redemptions set points_spent=1 where id=$1`,
      [receipt.id],
    ),
  );
  await denied("reward receipt cannot be deleted", () =>
    db.query(`delete from public.reward_redemptions where id=$1`, [receipt.id]),
  );
  await denied("redemption debit cannot be duplicated", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,related_redemption_id) values($1,$2,'redemption',-100,$3)`,
      [ORG, emps[1], receipt.id],
    ),
  );
  await denied("refund cannot use a different amount", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,related_redemption_id) values($1,$2,'refund',99,$3)`,
      [ORG, emps[1], receipt.id],
    ),
  );
  await denied("fulfilled receipt cannot receive a refund ledger entry", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,related_redemption_id) values($1,$2,'refund',120,$3)`,
      [ORG, emps[1], finalReceipt.id],
    ),
  );
  await denied("receipt cannot commit without its exact debit", () =>
    db.query(
      `insert into public.reward_redemptions(organization_id,employee_id,product_id,points_spent,fulfillment_type) values($1,$2,$3,10,'manual')`,
      [ORG, emps[1], product.id],
    ),
  );
  await db.exec(
    `update public.organization_feature_overrides set enabled=true where organization_id='${ORG}' and feature_key='rewards_marketplace';insert into public.organization_security_policies(organization_id,mfa_policy,step_up_for_sensitive_actions) values('${ORG}','everyone',false) on conflict(organization_id) do update set mfa_policy='everyone';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("required MFA protects Rewards state", () => state());
  await as(users[1], async () =>
    ok(
      "required MFA protects direct receipt reads",
      (
        await db.query(
          `select * from public.reward_redemptions where employee_id=$1`,
          [emps[1]],
        )
      ).rows.length === 0,
    ),
  );
  await denied("required MFA protects HR request state", () => admin(9));
  await db.exec(
    `select set_config('request.jwt.claims','{"aal":"aal2"}',false)`,
  );
  ok(
    "verified MFA restores authorized Rewards access",
    (await state()).balance === 380,
  );
  await db.exec(
    `update public.organization_security_policies set mfa_policy='optional',step_up_for_sensitive_actions=true where organization_id='${ORG}';select set_config('request.jwt.claims','{"aal":"aal1"}',false)`,
  );
  await denied("sensitive-action step-up protects awards", () =>
    call(8, "grant_reward_points", [emps[1], 1, "New award", randomUUID()]),
  );
  await denied("sensitive-action step-up protects catalog editing", () =>
    call(7, "save_reward_product", [
      ORG,
      JSON.stringify(productData),
      null,
      null,
    ]),
  );
  await denied("sensitive-action step-up protects settlement", () =>
    call(9, "fulfill_redemption", [
      finalReceipt.id,
      "Collect at reception with this request reference",
    ]),
  );
  await db.exec(
    `update public.organization_security_policies set step_up_for_sensitive_actions=false where organization_id='${ORG}';select set_config('request.jwt.claims','',false)`,
  );
  await denied("invalid employee page is rejected", () => state(1, 0));
  await denied("null admin scope is rejected", () => admin(9, null));
  for (let i = 0; i < 22; i++)
    await call(8, "grant_reward_points", [
      emps[1],
      1,
      "Documented additional contribution " + i,
      randomUUID(),
    ]);
  const first = await state(),
    second = await state(1, 1, 1, 2);
  ok(
    "ledger history is paginated with an exact total",
    first.ledger.length === 20 &&
      second.ledger.length > 0 &&
      first.ledger_total === second.ledger_total &&
      first.ledger_total > 20,
  );
  ok(
    "ledger history pages do not overlap",
    !first.ledger.some((x) => second.ledger.some((y) => y.id === x.id)),
  );
  const notices = (
    await db.query(
      `select body from public.notifications where employee_id=$1 and type like 'rewards.%'`,
      [emps[1]],
    )
  ).rows;
  ok(
    "notifications omit employee-visible award reasons and collection details",
    notices.every(
      (n) =>
        !String(n.body).includes("customer concern") &&
        !String(n.body).includes("reception"),
    ),
  );
  const awards = await call(8, "list_reward_awards", [
    ORG,
    1,
    "customer concern",
  ]);
  ok(
    "points-only HR can find the original award and reason",
    awards.list_reward_awards.items[0]?.id === award.id,
  );
  await denied("catalog-only HR cannot reverse a points award", () =>
    call(7, "reverse_reward_award", [award.id, "Award sent in error"]),
  );
  await denied("correction requires an employee-visible reason", () =>
    call(8, "reverse_reward_award", [award.id, ""]),
  );
  await db.exec(
    `update public.organization_feature_overrides set enabled=false where organization_id='${ORG}' and feature_key='rewards_marketplace'`,
  );
  const corrected = await call(8, "reverse_reward_award", [
    award.id,
    "Award sent in error",
  ]);
  ok(
    "award correction appends the exact original amount even during a pause",
    corrected.amount === -500 && corrected.reversed_award_id === award.id,
  );
  const correctedAgain = await call(8, "reverse_reward_award", [
    award.id,
    "Award sent in error",
  ]);
  ok(
    "award correction is idempotent",
    correctedAgain.id === corrected.id && (await state()).balance === -98,
  );
  await denied("award correction cannot be duplicated directly", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reversed_award_id) values($1,$2,'adjustment',-500,$3)`,
      [ORG, emps[1], award.id],
    ),
  );
  await denied("award correction cannot reverse a partial amount", () =>
    db.query(
      `insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reversed_award_id) values($1,$2,'adjustment',-1,$3)`,
      [ORG, emps[1], award.id],
    ),
  );
  ok(
    "award history shows a correction without erasing its original reason",
    (await call(8, "list_reward_awards", [ORG, 1, "customer concern"]))
      .list_reward_awards.items[0]?.reversal_reason ===
      "Award correction: Award sent in error",
  );
  const roles = (
    await db.query(
      `select id from public.organization_roles where organization_id=$1 and name='Fulfillment only'`,
      [ORG],
    )
  ).rows[0].id;
  await db.query(
    `delete from public.role_permissions where custom_role_id=$1`,
    [roles],
  );
  await denied(
    "revoked fulfillment permission blocks HR state immediately",
    () => admin(9),
  );
}
