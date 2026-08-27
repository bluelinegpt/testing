import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Compatibility entry for an already-executed migration whose source file was
 * lost from the workspace. The live database records this exact migration name
 * before the subsequent cash-account migrations. Keeping a no-op provider
 * entry lets Kysely validate that history without replaying or inventing the
 * original schema write.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`select 1`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`select 1`.execute(database);
}
