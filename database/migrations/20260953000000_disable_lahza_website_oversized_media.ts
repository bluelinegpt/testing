import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Emergency mitigation, not a permanent change: the `lahza` Company Website
 * still has its logo/banner saved as inline base64 from before branding
 * media moved to R2 (see the same day's "store Website logo/banners in R2"
 * and "hide legacy base64 branding media from the editor" commits). Its
 * public endpoint (`GET /public/company-website`) sends that entire payload
 * -- observed at ~10MB -- on every visit, which was repeatedly crashing the
 * API's 512MB instance with an out-of-memory error. The crash-looping got
 * bad enough that Platform Administration itself couldn't stay up long
 * enough to open the Website editor and fix it by hand.
 *
 * This does exactly what clicking "Disable" on lahza's Website in Platform
 * Administration would do (company_websites.status='disabled', enabled=
 * false, disabled_at=now()) -- nothing else changes, no settings data is
 * touched or deleted. `resolvePublic()` already returns a tiny
 * `{ availability: "disabled" }` for a disabled Website instead of the full
 * settings, so this stops the oversized public response immediately and
 * should end the crash loop.
 *
 * No audit_events row is written here: that table requires a real
 * actor_account_id, and there is no authenticated actor for a migration --
 * this file, its commit message, and the deploy that ran it are the record
 * of what happened and why.
 *
 * Re-enable from Platform Administration once the logo/banner have been
 * re-uploaded (they'll then be small R2 URLs, not base64) -- do not revert
 * this migration to re-enable, since the oversized data would still be
 * there and the instance would very likely start crashing again.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    update company_websites
       set status = 'disabled',
           enabled = false,
           disabled_at = now(),
           updated_at = now(),
           version = version + 1
     where slug = 'lahza'
       and status <> 'disabled'
  `.execute(database);
}

export async function down(): Promise<void> {
  // Deliberately a no-op -- see the comment above `up`.
}
