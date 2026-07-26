# Identity Administration Web Report

Implementation date: 2026-07-14

## Scope

The React web application now provides the first operational Company administration surface:

- Company subdomain, username, and password login.
- Access tokens retained in application memory only.
- Company user list with status, lock state, roles, and last-login date.
- Role assignment, account unlock, and reason-required deactivation actions.
- Company role list and custom-role creation/editing with permission selection.
- Protected system-role presentation and inactive-role controls.
- English and Arabic localization with LTR/RTL document direction.
- Responsive desktop and mobile layouts.

## Security Boundary

The client does not accept or persist a Company identifier as authorization authority. The API
continues to resolve Company context from the authenticated session, enforce identity kind and
permissions, scope all records server-side, protect the last administrator, and write audit events.
The access token is not written to local storage or session storage.

## Verification

- Formatting and linting passed.
- Strict API and web TypeScript checks passed.
- 31 API tests and 9 web tests passed; two PostgreSQL suites are opt-in and were previously
  verified as rollback-only journeys.
- API and web production builds passed.
- Browser checks passed at 1440 by 900 and 390 by 844 for login, users, roles, and the role editor.
- Visual checks used synthetic data served locally; no Company, account, role, session, or audit
  fixture was retained in PostgreSQL.

## Remaining Dependencies

- `B-006` still blocks permissions for sensitive business operations outside the implemented
  identity-administration subset.
- `B-009` still blocks Company onboarding, activation, suspension, and initial administrator
  provisioning.
- Password recovery delivery and privileged-account controls remain unresolved.
- The current web scope is not a complete delivery-management product and is not production-ready.
