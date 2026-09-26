import type { Kysely } from 'kysely';

/**
 * Restored historical migration marker.
 *
 * The production database has already recorded this migration as executed.
 * Kysely requires every executed migration name to exist in the deployed source
 * tree before it will continue running newer migrations.
 */
export async function up(_db: Kysely<unknown>): Promise<void> {
  // Intentionally no-op: this historical migration was already applied.
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally no-op.
}
