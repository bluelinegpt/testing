import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Shared Commerce Foundation Prompt 3C: secure guest/Customer Store Order
 * tracking.
 *
 * ---------------------------------------------------------------------------
 * WHY COLUMNS ON `store_orders`, NOT A SEPARATE TABLE
 * ---------------------------------------------------------------------------
 *
 * Every Store Order gets exactly one live tracking credential at a time
 * (§24: "one Store Order" per token), so there is no list to normalise into
 * a child table -- the same shape choice this codebase already made for
 * Delivery's own `tracking_tokens` table only because THAT table serves
 * potentially-rotating multi-row history across repeated public shares.
 * Prompt 3C's simplest-secure-model instruction (§48) is satisfied by three
 * columns: a hash (never the raw token), a creation timestamp, and a
 * nullable revocation timestamp that doubles as the rotate/revoke switch.
 *
 * ---------------------------------------------------------------------------
 * THE HASH-AT-REST IDIOM IS BORROWED, NOT INVENTED
 * ---------------------------------------------------------------------------
 *
 * `SessionTokenService` (`authentication/session-token.service.ts`) already
 * generates a 32-byte random token and stores only its sha256 hex digest --
 * used today for session tokens and password-reset tokens
 * (`password_reset_tokens.token_hash`). The Store Order tracking token
 * reuses the exact same service and the exact same "hash column, raw value
 * returned once" contract; nothing new is invented at the crypto layer.
 *
 * ---------------------------------------------------------------------------
 * NO STORE ORDER OWNERSHIP OR LIFECYCLE CHANGE (§49)
 * ---------------------------------------------------------------------------
 *
 * Purely additive nullable columns plus one partial unique index. No
 * existing column, constraint, or trigger from the 3B migration is touched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table store_orders
      add column tracking_token_hash text,
      add column tracking_token_created_at timestamptz,
      add column tracking_token_revoked_at timestamptz;

    -- §57: two Store Orders cannot accidentally share a tracking credential.
    -- Partial (only non-null, only live) so a revoked-then-reissued token's
    -- old hash does not permanently block reuse of that same hash value by
    -- coincidence -- astronomically unlikely with a 32-byte token, but the
    -- index is scoped correctly regardless.
    create unique index store_orders_tracking_token_hash_unique
      on store_orders (tracking_token_hash)
      where tracking_token_hash is not null and tracking_token_revoked_at is null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists store_orders_tracking_token_hash_unique;
    alter table store_orders
      drop column if exists tracking_token_revoked_at,
      drop column if exists tracking_token_created_at,
      drop column if exists tracking_token_hash;
  `.execute(database);
}
