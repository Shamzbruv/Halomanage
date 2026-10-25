// Real Postgres/RLS tests of the independent sign-off and export boundary.
export async function testTimesheets({ db, as, ok }) {
  const ORG = 'fa000000-0000-0000-0000-000000000001';
  const USERS = [1,2,3].map(n => `fa100000-0000-0000-0000-00000000000${n}`);
  const EMPS = [1,2,3].map(n => `fa200000-0000-0000-0000-00000000000${n}`);
  const UNIT = 'fa300000-0000-0000-0000-000000000001';
  const OTHER = 'fa000000-0000-0000-0000-000000000002';
  async function denied(label, fn) { let failed = false; try { await fn(); } catch { failed = true; } ok(label, failed); }
  await db.exec(`insert into public.organizations(id,name,slug,timezone) values ('${ORG}','Timesheet Tests','timesheet-tests','America/Jamaica'),('${OTHER}','Other Timesheets','other-timesheets','UTC');`);
  for (let i=0;i<3;i++) {
    await db.exec(`insert into auth.users(id,email) values ('${USERS[i]}','timesheet-${i}@test.invalid');
      insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status,hire_date)
      values('${EMPS[i]}','${ORG}','${USERS[i]}','TS-${i}','Test','Person ${i}','active','2020-01-01');
      insert into public.role_assignments(organization_id,user_id,role) values('${ORG}','${USERS[i]}','${i<2?'admin':'employee'}');`);
  }
  const day = (await db.query(`select (date_trunc('week',private.org_today('${ORG}')::timestamp)::date-7)::text as d`)).rows[0].d;
  const from = `'${day}'::date`;
  await db.exec(`insert into public.org_units(id,organization_id,name) values('${UNIT}','${ORG}','Support');
    insert into public.employee_assignments(organization_id,employee_id,org_unit_id,start_date,is_primary) values('${ORG}','${EMPS[2]}','${UNIT}','2020-01-01',true);
    update public.attendance_policies set break_deduction='recorded' where organization_id='${ORG}';`);
  const schedule = (await db.query(`insert into public.work_schedules(organization_id,name) values('${ORG}','Weekdays') returning id`)).rows[0].id;
  await db.exec(`insert into public.schedule_shifts(schedule_id,day_of_week,start_time,end_time,break_minutes) select '${schedule}',d,'09:00','17:00',0 from generate_series(1,5) d;
    delete from public.schedule_assignments where employee_id='${EMPS[2]}';
    insert into public.schedule_assignments(organization_id,employee_id,schedule_id,start_date) values('${ORG}','${EMPS[2]}','${schedule}','2020-01-01');`);
  const session = (await db.query(`insert into public.attendance_sessions(organization_id,employee_id,work_date,clock_in_at,clock_out_at,status)
    values('${ORG}','${EMPS[2]}',${from},(${from}+time '09:00') at time zone 'America/Jamaica',(${from}+time '18:00') at time zone 'America/Jamaica','closed') returning id`)).rows[0].id;
  await db.query(`select private.recompute_attendance_session('${session}',true)`);
  let policy, period;
  await as(USERS[0],async()=>{
    policy = (await db.query(`select public.create_attendance_policy('${ORG}','Support rules') as id`)).rows[0].id;
    await db.query(`select public.set_department_attendance_policy('${UNIT}','${policy}')`);
    period = (await db.query(`select * from public.create_attendance_period('${ORG}','Last Monday',${from},${from})`)).rows[0].id;
    await denied('review periods cannot overlap',()=>db.query(`select public.create_attendance_period('${ORG}','Duplicate',${from},${from}+1)`));
    await denied('periods are capped at 62 days',()=>db.query(`select public.create_attendance_period('${ORG}','Too long',${from}+10,${from}+100)`));
    await denied('cross-tenant period creation denied',()=>db.query(`select public.create_attendance_period('${OTHER}','Other',${from},${from})`));
    await denied('unlocked hours cannot be exported',()=>db.query(`select public.export_attendance_period('${period}')`));
    await denied('unsigned period cannot be locked',()=>db.query(`select public.set_attendance_period_lock('${period}',true)`));
  });
  const outsider='fa100000-0000-0000-0000-000000000004';
  await db.exec(`insert into auth.users(id,email) values('${outsider}','timesheet-outsider@test.invalid');
    insert into public.employees(id,organization_id,user_id,employee_number,first_name,last_name,status)
    values('fa200000-0000-0000-0000-000000000004','${OTHER}','${outsider}','OUT','Other','Tenant','active');
    insert into public.role_assignments(organization_id,user_id,role) values('${OTHER}','${outsider}','admin');`);
  await as(outsider,async()=>{
    ok('another tenant cannot read review periods',(await db.query(`select count(*) as n from public.attendance_periods where id='${period}'`)).rows[0].n==0);
    await denied('another tenant cannot lock a period',()=>db.query(`select public.set_attendance_period_lock('${period}',true)`));
  });
  ok('department policy takes priority over default',(await db.query(`select (private.employee_attendance_policy('${EMPS[2]}')).id as id`)).rows[0].id===policy);
  ok('existing punches keep their original policy snapshot',(await db.query(`select policy_id from public.attendance_sessions where id='${session}'`)).rows[0].policy_id!==policy);
  const otherPolicy=(await db.query(`insert into public.attendance_policies(organization_id,name) values('${OTHER}','Other tenant') returning id`)).rows[0].id;
  await as(USERS[0],()=>denied('cross-tenant department policy denied',()=>db.query(`select public.set_department_attendance_policy('${UNIT}','${otherPolicy}')`)));
  const sheets=(await db.query(`select id,employee_id from public.attendance_timesheets where period_id='${period}'`)).rows;
  const sheet=i=>sheets.find(s=>s.employee_id===EMPS[i]).id;
  await as(USERS[2],async()=>{
    ok('employees only read their own timesheet',(await db.query(`select count(*) as n from public.attendance_timesheets where period_id='${period}'`)).rows[0].n==1);
    await db.query(`update public.attendance_timesheets set status='approved' where id='${sheet(2)}'`);
    ok('employees cannot forge an approval with direct DML',(await db.query(`select status from public.attendance_timesheets where id='${sheet(2)}'`)).rows[0].status==='draft');
    await denied('pending overtime prevents signing',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','submit')`));
    await denied('employees cannot sign for a colleague',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(0)}','submit')`));
    await denied('employees cannot preview a colleague',()=>db.query(`select public.preview_attendance_timesheet('${sheet(0)}')`));
    await denied('employees cannot assign department policies',()=>db.query(`select public.set_department_attendance_policy('${UNIT}',null)`));
  });
  await as(USERS[0],()=>db.query(`select public.decide_overtime('${session}',true)`));
  await as(USERS[2],async()=>{
    const snap=(await db.query(`select public.preview_attendance_timesheet('${sheet(2)}') as s`)).rows[0].s;
    ok('snapshot separates regular and approved overtime',snap.regular_minutes===480 && snap.overtime_minutes===60 && snap.issues===0);
    await db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','submit')`);
    await denied('no employee can approve their own hours',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','approve')`));
  });
  await db.exec(`update public.role_assignments set role='supervisor' where user_id='${USERS[1]}' and organization_id='${ORG}'`);
  await as(USERS[1],()=>denied('team reviewer cannot approve outside management scope',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','approve')`)));
  await db.exec(`insert into public.management_scope(organization_id,actor_user_id,employee_id,scope_reason) values('${ORG}','${USERS[1]}','${EMPS[2]}','supervisor');`);
  await as(USERS[1],async()=>{
    ok('scoped reviewer can review the assigned employee',(await db.query(`select public.can_review_attendance_timesheet('${sheet(2)}') as b`)).rows[0].b===true);
    ok('scoped reviewer cannot review themselves',(await db.query(`select public.can_review_attendance_timesheet('${sheet(1)}') as b`)).rows[0].b===false);
  });
  await db.exec(`update public.role_assignments set role='admin' where user_id='${USERS[1]}' and organization_id='${ORG}'`);
  // Changing the source invalidates the submitted snapshot, including to/from old dates.
  await db.exec(`update public.attendance_sessions set worked_minutes=worked_minutes-1 where id='${session}'`);
  await as(USERS[0],async()=>{
    await denied('approval rejects attendance changed after sign-off',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','approve')`));
    await denied('return requires a reason',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','reject')`));
    await db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','reject','Please review amended clock time')`);
  });
  await db.query(`select private.recompute_attendance_session('${session}')`);
  const leaveDay=`(${from}+1)`;
  const paidType=(await db.query(`insert into public.leave_types(organization_id,name,code,is_paid) values('${ORG}','TS paid','TS-PAID',true) returning id`)).rows[0].id;
  const unpaidType=(await db.query(`insert into public.leave_types(organization_id,name,code,is_paid) values('${ORG}','TS unpaid','TS-UNPAID',false) returning id`)).rows[0].id;
  const leave=(await db.query(`insert into public.leave_requests(organization_id,employee_id,leave_type_id,start_date,end_date,total_days,status,submitted_by)
    values('${ORG}','${EMPS[2]}','${paidType}',${leaveDay},${leaveDay},0.5,'approved','${USERS[2]}') returning id`)).rows[0].id;
  await db.exec(`insert into public.leave_request_days(leave_request_id,work_date,day_fraction) values('${leave}',${leaveDay},0.5)`);
  const halfSession=(await db.query(`insert into public.attendance_sessions(organization_id,employee_id,work_date,clock_in_at,clock_out_at,status)
    values('${ORG}','${EMPS[2]}',${leaveDay},(${leaveDay}+time '09:00') at time zone 'America/Jamaica',(${leaveDay}+time '13:00') at time zone 'America/Jamaica','closed') returning id`)).rows[0].id;
  await db.query(`select private.recompute_attendance_session('${halfSession}',true)`);
  let leaveSnap=(await db.query(`select private.timesheet_snapshot('${EMPS[2]}',${leaveDay},${leaveDay}) as s`)).rows[0].s;
  ok('half-day work plus half-day paid leave is valid',leaveSnap.regular_minutes===240 && leaveSnap.paid_leave_minutes===240 && leaveSnap.issues===0);
  await db.exec(`update public.leave_requests set leave_type_id='${unpaidType}' where id='${leave}'`);
  leaveSnap=(await db.query(`select private.timesheet_snapshot('${EMPS[2]}',${leaveDay},${leaveDay}) as s`)).rows[0].s;
  ok('unpaid leave exports separately',leaveSnap.paid_leave_minutes===0 && leaveSnap.unpaid_leave_minutes===240);
  await db.exec(`update public.leave_request_days set day_fraction=1 where leave_request_id='${leave}'`);
  leaveSnap=(await db.query(`select private.timesheet_snapshot('${EMPS[2]}',${leaveDay},${leaveDay}) as s`)).rows[0].s;
  ok('full-day leave overlapping work requires resolution',leaveSnap.issues>0);

  for(let i=0;i<3;i++) await as(USERS[i],()=>db.query(`select public.act_on_attendance_timesheet('${sheet(i)}','submit')`));
  for(let i=0;i<3;i++) await as(USERS[i===0?1:0],()=>db.query(`select public.act_on_attendance_timesheet('${sheet(i)}','approve')`));
  await as(USERS[0],async()=>{
    await denied('roster cannot exclude an employee with recorded time',()=>db.query(`select public.update_attendance_period_roster('${period}','${EMPS[2]}',false,'Hide time')`));
    await db.query(`select public.set_attendance_period_lock('${period}',true)`);
    const rows=(await db.query(`select public.export_attendance_period('${period}') as r`)).rows[0].r;
    ok('locked export contains only approved snapshots',rows.length===3 && rows.find(r=>r.employee_number==='TS-2').regular_minutes===480);
    await denied('reopening requires a reason',()=>db.query(`select public.set_attendance_period_lock('${period}',false)`));
  });
  await as(USERS[2],async()=>{
    await denied('employees cannot export organization hours',()=>db.query(`select public.export_attendance_period('${period}')`));
    await denied('locked submission cannot be withdrawn',()=>db.query(`select public.act_on_attendance_timesheet('${sheet(2)}','withdraw')`));
  });
  await denied('locked sources reject timestamp changes',()=>db.exec(`update public.attendance_sessions set clock_out_at=clock_out_at+interval '1 minute' where id='${session}'`));
  await denied('locked sources reject moving a session out of the period',()=>db.exec(`update public.attendance_sessions set work_date=work_date+1 where id='${session}'`));
  await denied('locked sources reject deletion',()=>db.exec(`delete from public.attendance_sessions where id='${session}'`));
  await denied('locked period rejects inserting a late session',()=>db.exec(`insert into public.attendance_sessions(organization_id,employee_id,work_date,clock_in_at,clock_out_at,status) values('${ORG}','${EMPS[0]}',${from},${from}+time '09:00',${from}+time '10:00','closed')`));
  await denied('locked period rejects break changes',()=>db.exec(`insert into public.attendance_breaks(organization_id,employee_id,session_id,started_at,ended_at) values('${ORG}','${EMPS[2]}','${session}',${from}+time '12:00',${from}+time '12:15')`));
  await db.exec(`update public.attendance_sessions set worked_minutes=worked_minutes where id='${session}'`);
  ok('maintenance no-op updates remain safe',true);
  await as(USERS[0],()=>db.query(`select public.set_attendance_period_lock('${period}',false,'Verified correction requested')`));
  ok('reopening invalidates every signature',(await db.query(`select count(*) as n from public.attendance_timesheets where period_id='${period}' and status='draft' and submitted_by is null and decided_by is null`)).rows[0].n==3);
  ok('superseded approvals remain in audit history',(await db.query(`select count(*) as n from public.audit_events where entity_id='${period}' and action='TIMESHEET_APPROVALS_SUPERSEDED' and jsonb_array_length(old_data)=3`)).rows[0].n==1);
  await as(USERS[0],()=>denied('reopened period cannot export stale approvals',()=>db.query(`select public.export_attendance_period('${period}')`)));
  ok('new submission increments revision',(await as(USERS[2],()=>db.query(`select revision from public.act_on_attendance_timesheet('${sheet(2)}','submit')`))).rows[0].revision===3);
}
