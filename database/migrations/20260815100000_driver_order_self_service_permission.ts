import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * A Driver User's own permission, distinct from the office `orders.*`
 * permissions.
 *
 * `orders.update_delivery_status` cannot be reused for this: holding it
 * makes `OperationsService.changeOrderStatus` treat the caller as a full
 * Operator (`hasOperatorStatusPermission`), which skips BOTH the
 * own-Order-only scoping and the narrower Driver transition set. A Driver
 * User must reach the same List/Detail endpoints an Operator does, but
 * WITHOUT ever being mistaken for one — hence a permission of its own that
 * unlocks visibility only, while every write still goes through the
 * ownership + narrow-transition path `changeOrderStatus` already implements
 * for a Driver User (see the "Driver Physical Correction" work in
 * `operations.service.ts`).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description) values
      ('orders.driver_self_service', 'View and act on the Driver User''s own assigned Orders')
    on conflict (code) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'orders.driver_self_service';
    delete from permissions where code = 'orders.driver_self_service';
  `.execute(database);
}
