import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Customer tracking credentials are not internal accounts. This migration
 * gives their short-lived messaging sessions an explicit, auditable scope
 * without manufacturing an account for a customer.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table customer_messaging_sessions
      add column conversation_id uuid,
      add column last_read_message_id uuid,
      add column revocation_reason text;

    alter table customer_messaging_sessions
      add constraint customer_messaging_sessions_conversation_fk
        foreign key (conversation_id, company_id)
        references conversations(id, company_id) on delete restrict,
      add constraint customer_messaging_sessions_last_read_fk
        foreign key (last_read_message_id, company_id)
        references messages(id, company_id) on delete restrict;

    create index customer_messaging_sessions_conversation_index
      on customer_messaging_sessions (company_id, conversation_id)
      where revoked_at is null;

    alter table conversation_participants
      alter column account_id drop not null,
      add column customer_messaging_session_id uuid;
    alter table conversation_participants
      drop constraint conversation_participants_account_fk,
      add constraint conversation_participants_account_fk
        foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint conversation_participants_customer_session_fk
        foreign key (customer_messaging_session_id, company_id)
        references customer_messaging_sessions(id, company_id) on delete restrict;
    alter table conversation_participants
      drop constraint conversation_participants_context_check,
      add constraint conversation_participants_context_check check (
        (participant_role = 'office' and account_id is not null and customer_messaging_session_id is null and trader_id is null and driver_id is null and customer_id is null)
        or (participant_role = 'trader' and account_id is not null and customer_messaging_session_id is null and trader_id is not null and driver_id is null and customer_id is null)
        or (participant_role = 'driver' and account_id is not null and customer_messaging_session_id is null and trader_id is null and driver_id is not null and customer_id is null)
        or (participant_role = 'customer' and account_id is null and customer_messaging_session_id is not null and customer_id is not null and trader_id is null and driver_id is null)
      );

    alter table realtime_event_log
      alter column audience_account_id drop not null,
      add column customer_messaging_session_id uuid;
    alter table realtime_event_log
      drop constraint realtime_event_log_audience_fk,
      add constraint realtime_event_log_audience_fk
        foreign key (audience_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint realtime_event_log_customer_session_fk
        foreign key (customer_messaging_session_id, company_id)
        references customer_messaging_sessions(id, company_id) on delete restrict,
      add constraint realtime_event_log_audience_check check (
        (audience_account_id is not null and customer_messaging_session_id is null)
        or (audience_account_id is null and customer_messaging_session_id is not null)
      );
    create index realtime_event_log_customer_recovery_index
      on realtime_event_log (company_id, customer_messaging_session_id, sequence_number, created_at)
      where customer_messaging_session_id is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists realtime_event_log_customer_recovery_index;
    alter table realtime_event_log
      drop constraint if exists realtime_event_log_audience_check,
      drop constraint if exists realtime_event_log_customer_session_fk,
      drop constraint if exists realtime_event_log_audience_fk,
      drop column if exists customer_messaging_session_id,
      alter column audience_account_id set not null,
      add constraint realtime_event_log_audience_fk foreign key (audience_account_id, company_id)
        references accounts(id, company_id) on delete restrict;
    alter table conversation_participants
      drop constraint if exists conversation_participants_customer_session_fk,
      drop constraint if exists conversation_participants_account_fk,
      drop constraint if exists conversation_participants_context_check,
      drop column if exists customer_messaging_session_id,
      alter column account_id set not null,
      add constraint conversation_participants_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict;
    alter table customer_messaging_sessions
      drop constraint if exists customer_messaging_sessions_last_read_fk,
      drop constraint if exists customer_messaging_sessions_conversation_fk,
      drop column if exists revocation_reason,
      drop column if exists last_read_message_id,
      drop column if exists conversation_id;
    drop index if exists customer_messaging_sessions_conversation_index;
  `.execute(database);
}
