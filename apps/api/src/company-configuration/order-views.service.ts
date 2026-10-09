import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { type OrderView, standardOrderViews, validateOrderViews } from "./order-views.js";

export interface OrderViewsMenu {
  /** False: the Orders screen uses the standard menu, exactly as before. */
  readonly enabled: boolean;
  /** True when the Company has never saved a menu (these are the defaults). */
  readonly isStandard: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** 0 when never saved. Send back as `expectedVersion` on save. */
  readonly version: number;
  readonly views: readonly OrderView[];
}

export interface SaveOrderViewsMenuInput {
  readonly enabled: boolean;
  readonly expectedVersion?: number | undefined;
  readonly views: readonly unknown[];
}

@Injectable()
export class OrderViewsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  /** The Company's menu, or the standard one when none has been saved. */
  public async menu(): Promise<OrderViewsMenu> {
    const { companyId } = this.tenants.current();
    return this.read(this.database, companyId);
  }

  /**
   * Replaces the whole menu atomically. Every save is validated against the
   * same rules the Orders list will apply, and refused (409) when someone else
   * saved since this screen loaded it.
   */
  public async save(input: SaveOrderViewsMenuInput, correlationId: string): Promise<OrderViewsMenu> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const validation = validateOrderViews(input.views);
    if (!validation.ok) {
      throw new ApplicationException(
        "order_views_invalid",
        "The Orders menu has problems that must be fixed before saving",
        HttpStatus.BAD_REQUEST,
        validation.errors,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const current = await sql<{ version: number }>`
        select version from company_order_view_menus
        where company_id = ${companyId}::uuid
        for update
      `.execute(transaction);
      const currentVersion = current.rows[0]?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new ApplicationException(
          "order_views_version_conflict",
          "Someone else changed the Orders menu. Reload it and apply your changes again.",
          HttpStatus.CONFLICT,
        );
      }
      const views = JSON.stringify(validation.views);
      await sql`
        insert into company_order_view_menus (
          company_id, custom_menu_enabled, views, version, updated_by_account_id
        ) values (
          ${companyId}::uuid, ${input.enabled}, ${views}::jsonb, 1, ${identity.identityId}::uuid
        )
        on conflict (company_id) do update
          set custom_menu_enabled = excluded.custom_menu_enabled,
              views = excluded.views,
              version = company_order_view_menus.version + 1,
              updated_by_account_id = excluded.updated_by_account_id,
              updated_at = now()
      `.execute(transaction);
      await sql`
        insert into audit_events (
          company_id, actor_account_id, action, subject_type, subject_id,
          after_data, correlation_id
        ) values (
          ${companyId}::uuid, ${identity.identityId}::uuid, 'company.order_views.update',
          'company_order_view_menu', ${companyId},
          ${JSON.stringify({
            enabled: input.enabled,
            views: validation.views.map((view) => view.key),
          })}::jsonb,
          ${correlationId}
        )
      `.execute(transaction);
      return this.read(transaction, companyId);
    });
  }

  private async read(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<OrderViewsMenu> {
    const result = await sql<{
      enabled: boolean;
      updatedAt: string;
      updatedBy: string | null;
      version: number;
      views: unknown;
    }>`
      select m.custom_menu_enabled as enabled,
             m.views,
             m.version,
             m.updated_at::text as "updatedAt",
             a.username as "updatedBy"
      from company_order_view_menus m
      left join accounts a on a.id = m.updated_by_account_id and a.company_id = m.company_id
      where m.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      return {
        enabled: false,
        isStandard: true,
        updatedAt: null,
        updatedBy: null,
        version: 0,
        views: standardOrderViews(),
      };
    }
    // Stored menus were validated on save; re-validate on read so a menu
    // written by an older rule set can never reach the Orders screen broken.
    const validation = validateOrderViews(row.views);
    return {
      enabled: row.enabled && validation.ok,
      isStandard: false,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      version: row.version,
      views: validation.ok ? validation.views : standardOrderViews(),
    };
  }
}
