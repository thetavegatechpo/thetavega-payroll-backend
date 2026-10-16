# Thetavega Payroll — MongoDB Backend Architecture

## Scope
This archive is the **backend only**. Phase 1 executable APIs: authentication, department/designation masters, employee CRUD, configuration, versioned rule definitions, salary component catalog. Collections for attendance, overtime, salary structures, payroll periods and records are scaffolded for future phases; **payroll calculations, statutory evaluation, approval, payslip generation and reporting are NOT implemented yet**.

## Setup
1. Install Node.js 20+ and MongoDB (local or Atlas).
2. `npm install`
3. Copy `.env.example` to `.env` and set MongoDB URI, strong JWT_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD.
4. `npm run seed`
5. `npm run dev`
6. Test `GET http://localhost:5000/api/health`
7. `POST /api/auth/login` with JSON `{"email":"admin@thetavega.local","password":"your password"}`.

Use `Authorization: Bearer <token>` for all protected endpoints.

## Phase 1 endpoints
- `POST /api/auth/login`, `GET /api/auth/me`
- `GET,POST /api/masters/departments`
- `PATCH /api/masters/departments/:id`
- `GET,POST /api/masters/designations`
- `PATCH /api/masters/designations/:id`
- `GET,POST /api/employees`
- `GET,PATCH /api/employees/:id`
- `PATCH /api/employees/:id/status`
- `GET /api/config/settings`, `PUT /api/config/settings/:key`
- `GET,POST /api/config/rules`
- `GET,POST /api/config/salary-components`

Example: create a department and designation first, then POST employee:
`{"firstName":"Asha","lastName":"Sharma","department":"<department MongoDB ObjectId>","designation":"<designation MongoDB ObjectId>","joiningDate":"2026-10-01"}`.

## Dynamic configuration design
MongoDB collections `settings`, `rules`, `salarycomponents` allow company settings, effective-dated rule versions, and configurable earnings/deduction component definitions. Employee code sequence is generated atomically using `counters`. Rule `config` is flexible JSON and must be validated against category-specific schemas before production use. Do not execute user-supplied JavaScript or formulas. Changes to settings/rules are not yet connected to a payroll engine.

## Important security and production work
The current employee GET API intentionally excludes banking and statutory identifiers. Employee create/update accepts these fields; dedicated encrypted storage, privileged access, redacted audit snapshots, and key management are needed before storing real employee financial/identity data. Do not use this scaffold with real sensitive employee data until those controls are implemented. Rule version allocation is not concurrency-safe; add atomic per-rule version counters or transactions before concurrent administration. Zod errors need a 400 mapping before deployment. Restrict dynamic settings keys and rule schemas; lock company policy changes after payroll processing. Run full integration and security tests before production.

## Roadmap
Phase 2: salary structures, component calculation definitions, effective dating.
Phase 3: attendance with calendar-day reconciliation, manual approved OT.
Phase 4: Decimal128 payroll calculations, deduction rule interpreter and eligibility, snapshots.
Phase 5: admin approval, immutable locking, PDF payslips.
Phase 6: reports, exports, reconciliation, deployment hardening.
