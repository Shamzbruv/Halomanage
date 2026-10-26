# Onboarding — HR and engineering audit

Reviewed 25 October 2026 (America/Jamaica). Scope: employee Onboarding, preboarding/invitation integration, HR templates, task ownership, prerequisites, forms, attestations, documents/evidence, dates, reporting and retained records. Implementation ships through GitHub main; Railway is not operated manually.

## Research and HR decisions

- [CIPD: Induction](https://www.cipd.org/en/knowledge/factsheets/induction-factsheet/) frames induction as welcoming and supporting people so they understand the organisation and their role. HaloManage keeps an employer-owned framework rather than treating onboarding as a collection of unverified checkmarks. Templates cover preparation, first-day and later support; managers and specialist owners receive their own assigned work.
- [Acas: Planning an induction programme](https://www.acas.org.uk/inductions/planning-an-induction-programme) recommends planning before the start date, tailoring the programme, spreading activities over time and considering location, support needs and responsibilities. The application supports prehire planning, named owners, phased templates, hire/invitation/probation-date anchors, structured feedback, blocker reports and explained date overrides. This is general operational guidance; UK-specific legal examples are not imported as Jamaican employment requirements.
- [Acas: Induction checklist](https://www.acas.org.uk/template-checklist-for-induction-of-new-staff) provides an adaptable baseline. The existing editable standard framework remains available. Employers decide which steps apply, who verifies them and what evidence they require; this release does not overwrite customised plans.
- [Jamaica Office of the Information Commissioner: Data Protection Standards](https://www.oic.gov.jm/page/data-protection-standards) informs limited access, accuracy, security and retention. Monitoring progress does not automatically disclose employee form responses or uploaded artifacts. Private data belongs in the official HR record, not general task instructions or notifications.

An account attestation records a signed-in person, explicit confirmation, their typed name and server time. It is not presented as a qualified electronic signature or a substitute for the employer's contract-signature process. Onboarding completion does not itself confirm probation, change employment status or pay, issue leave entitlement, grant application roles or prove regulatory compliance.

## Findings and fixes

| Gap | Implemented behavior |
|---|---|
| An organisation-level task-management permission could modify employees outside the manager's scope | Start, planning, completion overrides, cancellation, reassignment and rescheduling require the appropriate employee scope; HR employee-management authority remains organisation-wide |
| Completed-task retries returned before checking authority | Authorization, account eligibility, MFA and run state are checked before returning an existing completion |
| Signature steps could be completed with no consent | Explicit confirmation and typed name by the assigned person; HR cannot attest as an employee |
| Forms had no usable employee input flow | Versioned form questions, type/required-field validation, narrative fallback and private response records |
| Upload tasks accepted an empty completion | Actual attached document metadata or a registered private upload is required |
| Evidence followed a document's latest version | Attachments and review steps preserve the exact document version; referenced metadata/files cannot be overwritten or deleted through ordinary client access |
| Assigned support staff had broken task notifications | Working `/onboarding/tasks/[id]` pages provide the task and minimal subject context without full directory or run access |
| Task descriptions/answers could spread into broad monitoring and notifications | New private response table; legacy task rows contain a response marker; new assignment notifications contain no task instructions or answers |
| Repeated starts created duplicate active plans | Employee lock and retry-safe reuse of the existing plan; a different active template requires review before a new start |
| Already existing duplicates would be damaged by a uniqueness cleanup | Existing runs are retained; HR queue flags multiple active plans for a deliberate decision |
| Stale account links and default-owner changes left work with the wrong account | Open tasks re-resolve ownership, clear unlinked/ineligible accounts, follow changed defaults and preserve manual assignments |
| Optional steps became stranded after required work closed a plan | Optional work remains actionable after required completion; employees may waive their own optional step with a reason |
| Waivers looked like normal completions | Distinct waived status, actor/time, private reason and separate counts; required waivers are scoped HR decisions |
| No blocker or scheduling workflow | Assignees report pending/in-progress/blocked status; managers can override dates with a reason or restore the template anchor |
| HR lists silently stopped at an implicit API limit | Filtered, searched and paginated run/task lists with exact totals |
| Historical labels changed with template names | Run snapshots preserve the template label/version and employee name; task instructions and used versions cannot be rewritten |
| Limited roles depended on broad employee-directory access | Minimal scoped employee choices and task/run projections support template managers, scoped managers and IT owners |
| Security rules differed across UI and backend | Invoker API wrappers, unexposed implementations, explicit grants/RLS, required MFA, sensitive-action checks and the existing network policy |

## Employee and assigned-owner workflow

Prehire accounts, active employees and staff on leave can access the work assigned to them. Planning also works before the onboardee has an account; the invitation-linking flow uses the same instantiation and assignment helpers. Suspended and terminated accounts cannot act. An unlinked account loses its previous task access; relinking or restoring eligibility updates open manual assignments without replacing the chosen person.

The personal list separates open work from history and includes tasks the user owns for other employees. Each task opens its own page with instructions, owner, phase, due date, prerequisite status and completion requirements. Employees can record progress or a blocker. Uploads accept PDF/PNG/JPEG up to 15 MB in a private Supabase bucket, without external providers. The database validates task ownership and the uploaded object's presence/available metadata before registration; this is not a malware-scanning claim.

Structured forms support text, number, date and confirmation fields, with up to 20 questions. Required values and types are checked server-side and unknown fields are rejected. A form with no configured questions uses a narrative response. Meeting, training, approval and checkpoint tasks require a factual completion note. Document review/acknowledgement and attestation require explicit confirmation; personal employee forms and attestations cannot be submitted by HR on the employee's behalf. An employee cannot approve their own approval step.

Prerequisites must belong to the same version and cannot form cycles. Completion checks that each prerequisite has a corresponding resolved task in the same run; a missing prerequisite cannot pass by returning an empty query result. A formal HR waiver counts as a resolved prerequisite, with its waived status preserved.

## HR administration, dates and history

Templates are created atomically with their initial version. The existing versioning engine forks a used version before edits, including configured form questions and linked review documents. Used steps/version identity and started task instructions are protected against direct edits. Archive templates for future use; cancellation closes an active run while retaining tasks, responses and evidence.

New starts are serialized per employee. A matching retry returns the existing active plan; it does not silently replace a plan or create another one. Empty or archived templates and ineligible subjects cannot start new runs. At review time production contained five runs, 12 tasks and one employee with multiple active plans. These records were preserved and the queue now flags the duplicate condition; no existing run was silently cancelled.

Default HR/IT responsibility changes apply to open tasks that follow the default. Named template owners and manual reassignments remain distinct. Reassignment and completion serialize on the run before locking tasks, and authorization is checked again after the lock. Assignment notifications also cover reassignment and use the working task URL.

Due dates retain organisation-local calendar behavior and the existing hire/invitation/probation anchors. Missing anchor dates remain visibly undated rather than inventing a deadline. Hire-date changes update open anchored steps; completed work stays unchanged. An explained manual date override is preserved until HR restores the anchor.

Required work can close a plan while optional work remains available. If a plan contains only optional work, all its steps must be resolved before it closes. Cancelled plans accept no further completion, reassignment or evidence. Completed work is not reopened or rewritten through these APIs. Corrections that require a new process should use a reviewed new plan rather than falsifying the old record.

The HR queue shows overdue, blocked, unassigned and waived counts, historical outcomes and duplicate active plans. Employee HR cards use stored historical template labels. Reporting excludes cancelled-plan checkpoints from the active checkpoint metric and labels open evidence work accurately; it does not claim that every pending signature step proves a missing document or that only 30/60/90-day programmes exist.

## Security and integration

Updated public Onboarding API methods are `SECURITY INVOKER` wrappers over guarded implementations in unexposed `onboarding_internal`. Retired implementations and internal helpers are not client-executable. New tables have RLS and explicit SELECT grants; writes use checked RPCs. Template-level writes are still compatible with existing forms, but direct mutation of used versions is blocked.

Progress monitoring is separate from personal responses. The employee, current task owner and authorised employee-management HR can read a response or direct onboarding upload; general team monitoring alone cannot. Existing linked document permissions remain independently enforced: knowing a document ID or owning an onboarding task does not expose HR-only documents. Referenced document versions and ordinary Storage content are protected against replacement/deletion; attachment/review takes a shared version lock, Storage content changes take conflicting version locks, and an unavailable file cannot be registered as evidence; changing the document's current version does not change the receipt. New uploads use task-specific private paths, cannot be reassigned to another task path and have no client update/delete policy.

Onboarding routes use private/no-store, no-index and no-referrer headers. Personal input is omitted from new generic task audit payloads/notifications. Existing historical audit data is retained; this migration is not a retrospective erasure operation. Employer retention, legal-hold and access policies still need to be defined and administered.

Invitation provisioning, official employee information, Documents, training and probation retain their own authority. Completing an onboarding training step records the supplied evidence/note; it does not fabricate completion in the Learning module. A probation checkpoint records an HR process outcome, not an automatic contractual change. Payroll continues to import external calculations. No additional external API or signature provider is introduced.

## Validation and release boundaries

- **919 database assertions pass**, including **102 Onboarding-specific assertions**, all prior workflows and the corrected legacy fixture that previously onboarded a terminated employee without meaningful evidence.
- Tests cover prehire/leave eligibility, scope and tenant isolation, authorization on retries, dependency cycles/missing references, forms, signatures, private responses, upload policies, versioned documents, waivers, optional work, cancellation, assignment changes, history, required MFA, step-up and network policy.
- TypeScript, lint and client-boundary checks pass; lint retains nine existing warnings. The production build passes after removing a corrupt generated cache and rebuilding cleanly.
- Live Supabase migrations `20261026003735_onboarding_hr_workflow.sql` and `20261026010335_onboarding_evidence_locking.sql` are recorded. An authenticated-role smoke transaction exercised the workflow, document-version locking and preservation guards, forced deferred constraints and rolled back. Storage metadata fixtures verify database policy behavior; no claim of physical file delivery is made. The original five runs and 12 tasks remained; no sample files were retained.
- Live security advisories decreased from **142 to 124**, with **no new findings**. GitHub CI checks the main release commit before completion is reported.

The live smoke verifies database authorization/workflow behavior, not an actual invited-user browser session or binary upload/download over Storage HTTP. PGlite is not a multi-session concurrency stress test. Outbound email/SMS delivery, external contract signing and Railway auto-deployment remain unverified. The existing network-policy mechanism is respected; its broader infrastructure/trust model is not redesigned in this task.
