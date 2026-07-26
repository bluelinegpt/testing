# Prompt 2 Required Input List

> Resolved on 2026-07-13: The Project Owner selected the alternative resume condition and
> explicitly authorized a new schema design from the approved Version 3.0 requirements. No
> owner-supplied legacy baseline is required for the current implementation.

## Blocking Input

Provide the authoritative existing PostgreSQL schema package. The minimum blocking artifact is the complete SQL/DDL baseline that Prompt 2 can preserve and validate.

Place the approved package under:

```text
database/baseline/
```

## Required Package Contents

1. Complete ordered SQL/DDL needed to create the existing schema from an empty PostgreSQL database.
2. Schema version, source system/repository, author or owner, and approval status.
3. Supported PostgreSQL major version and required extensions.
4. Any prerequisite scripts, custom types, domains, functions, procedures, triggers, and roles required by the DDL.
5. Existing migration files and migration history table details, if the schema has already evolved.
6. Repeatable reference or seed-data scripts, if they exist.
7. Existing data dictionary, ER diagram, or database notes, if available.
8. A statement identifying whether the baseline is:
   - an empty-system creation script;
   - an export from an active development database; or
   - a production-derived structure.
9. A statement identifying any known compatibility, ordering, or data-migration requirements.

## Safety Requirements

- Do not include usernames, passwords, connection strings, API keys, or other secrets.
- Do not include production rows or sensitive sample data.
- If representative rows are essential to explain a constraint, provide separately generated and fully anonymized test fixtures.
- Do not overwrite the supplied baseline after validation; corrections will be delivered as controlled forward migrations.

## Optional Runtime Input

For migration execution after static validation, provide development-only database credentials through `DATABASE_URL` outside source control. The local PostgreSQL server is already reachable at `127.0.0.1:5432`.

## Resume Condition

Prompt 2 database implementation can resume when the complete authoritative SQL/DDL baseline is present and its version/origin are identifiable. Partial screenshots, table lists, ORM snippets, or prose descriptions are insufficient substitutes.
