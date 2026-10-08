import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Immutable operator acknowledgements for Company Integrity findings. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists integrity_acceptances (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete cascade,
      check_code text not null,
      subject_type text not null,
      subject_id uuid not null,
      fingerprint text not null,
      accepted_by_platform_user_id uuid not null references accounts(id),
      accepted_at timestamptz not null default now(),
      note text not null,
      constraint integrity_acceptances_check_code_nonempty check (btrim(check_code) <> ''),
      constraint integrity_acceptances_subject_type_nonempty check (btrim(subject_type) <> ''),
      constraint integrity_acceptances_fingerprint_nonempty check (btrim(fingerprint) <> ''),
      constraint integrity_acceptances_note_nonempty check (btrim(note) <> '')
    );
    create unique index if not exists integrity_acceptances_live_unique
      on integrity_acceptances(company_id, check_code, subject_type, subject_id, fingerprint);
    create index if not exists integrity_acceptances_company_index
      on integrity_acceptances(company_id, check_code, accepted_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists integrity_acceptances`.execute(database);
}
