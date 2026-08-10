import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Adds real voice-message support to the existing `messages` table (Prompt
 * 14). `voice_placeholder` already reserved a `message_type` value for this
 * exact feature but nothing ever inserted one — this migration introduces the
 * functional `voice` type alongside it rather than repurposing it, so no
 * historical row (there are none, but the principle holds) is reinterpreted.
 *
 * Additive only: every existing `text`/`system`/`voice_placeholder` row
 * remains valid — the four new columns are nullable and NULL for all of them,
 * and the widened CHECK constraints only add a new allowed shape, they never
 * narrow the existing ones.
 *
 * Voice media bytes are NOT stored in this table. They reuse the existing
 * `file_objects` + `FileStoragePort` storage abstraction already used for
 * Company logos and General Expense attachments (see
 * `apps/api/src/files/file-storage.port.ts`) — `media_file_object_id` is a
 * foreign key to that table, matching the composite `(id, company_id)`
 * pattern already used by every other `file_objects` foreign key in this
 * schema (e.g. `conversations_last_message_fk`, `messages_conversation_fk`).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table messages
      add column media_file_object_id uuid,
      add column media_duration_seconds integer,
      add column media_mime_type text,
      add column media_size_bytes bigint;

    alter table messages
      add constraint messages_media_file_fk foreign key (media_file_object_id, company_id)
      references file_objects(id, company_id) on delete restrict;

    alter table messages drop constraint messages_type_check;
    alter table messages add constraint messages_type_check
      check (message_type in ('text', 'system', 'voice_placeholder', 'voice'));

    alter table messages drop constraint messages_text_shape_check;
    alter table messages add constraint messages_text_shape_check check (
      (message_type = 'text' and text_body is not null and length(text_body) between 1 and 4000 and system_event_type is null)
      or (message_type = 'system' and text_body is null and system_event_type is not null)
      or (message_type = 'voice_placeholder' and text_body is null)
      or (
        message_type = 'voice' and text_body is null and system_event_type is null
        and media_file_object_id is not null and media_mime_type is not null
        and media_size_bytes is not null and media_duration_seconds is not null
      )
    );

    -- Defense in depth alongside the application-layer MIME/size/duration
    -- allowlist: the database itself never accepts a Voice message outside
    -- the product's stated limits (5 minutes, 10 MiB -- the latter already
    -- matches the pre-existing file_objects_size_check ceiling).
    alter table messages add constraint messages_voice_media_bounds_check check (
      message_type <> 'voice'
      or (media_duration_seconds between 1 and 300 and media_size_bytes between 1 and 10485760)
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table messages drop constraint if exists messages_voice_media_bounds_check;

    alter table messages drop constraint if exists messages_text_shape_check;
    alter table messages add constraint messages_text_shape_check check (
      (message_type = 'text' and text_body is not null and length(text_body) between 1 and 4000 and system_event_type is null)
      or (message_type = 'system' and text_body is null and system_event_type is not null)
      or (message_type = 'voice_placeholder' and text_body is null)
    );

    alter table messages drop constraint if exists messages_type_check;
    alter table messages add constraint messages_type_check
      check (message_type in ('text', 'system', 'voice_placeholder'));

    alter table messages drop constraint if exists messages_media_file_fk;
    alter table messages drop column if exists media_file_object_id;
    alter table messages drop column if exists media_duration_seconds;
    alter table messages drop column if exists media_mime_type;
    alter table messages drop column if exists media_size_bytes;
  `.execute(database);
}
