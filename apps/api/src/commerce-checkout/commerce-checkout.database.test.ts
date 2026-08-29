import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";

import { CommerceCheckoutService } from "./commerce-checkout.service.js";

/**
 * Customer Commerce Prompt C2 -- Checkout revalidation/preview, against the
 * real schema.
 *
 * One outer transaction, always rolled back, mirroring
 * `store-order.database.test.ts`. `RequestSecurityContextStore` is a real
 * instance (not stubbed) so guest-vs-logged-in behavior is exercised through
 * its actual AsyncLocalStorage semantics -- `.run()` for a logged-in
 * Customer, no `.run()` at all for a guest (so `.current()` throws, exactly
 * as it would for an unauthenticated real request).
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

describe.skipIf(!runDatabaseTests)("CommerceCheckoutService (Customer Commerce Prompt C2)", () => {
  it("revalidates lines, resolves delivery and computes authoritative COD totals", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const rollbackMarker = Symbol("rollback checkout test");

    try {
      await database.transaction().execute(async (transaction) => {
        const ids = {
          areaId: randomUUID(),
          categoryId: randomUUID(),
          pricingCreatorAccountId: randomUUID(),
          commerceId: randomUUID(),
          companyId: randomUUID(),
          customerAccountId: randomUUID(),
          customerAddressId: randomUUID(),
          customerId: randomUUID(),
          groupId: randomUUID(),
          otherCustomerAddressId: randomUUID(),
          otherCustomerId: randomUUID(),
          productId: randomUUID(),
          relationshipCompanyId: randomUUID(),
          relationshipTraderId: randomUUID(),
          storefrontId: randomUUID(),
          traderId: randomUUID(),
          valueId: randomUUID(),
        };
        const short = ids.companyId.slice(0, 8);
        const relShort = ids.relationshipCompanyId.slice(0, 8);

        const dubai = await sql<{ id: string }>`
          select id from emirates where name_en = 'Dubai'
        `.execute(transaction);
        const emirateId = dubai.rows[0]!.id;

        await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
          (${ids.companyId}::uuid,${`CO-${short}`},${`co-${short}`},'Checkout Test','active',now()),
          (${ids.relationshipCompanyId}::uuid,${`COR-${relShort}`},${`cor-${relShort}`},'Checkout Delivery Co','active',now())`.execute(
          transaction,
        );
        await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
          (${ids.traderId}::uuid,${ids.companyId}::uuid,${`TR-${short}`},'Checkout Trader','971500000030'),
          (${ids.relationshipTraderId}::uuid,${ids.relationshipCompanyId}::uuid,${`TR-${relShort}`},'Checkout Delivery Trader','971500000031')`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
          values(${ids.commerceId}::uuid,'Checkout Shop','delivery_company_registered','approved')`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
          values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
          transaction,
        );
        // A single active, Store-Order-enabled relationship with a real
        // Company-scoped Trader (§27-29) -- pricing must resolve through
        // THIS relationship's own trader_id, never by name.
        await sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, trader_id, relationship_source, status,
            enabled_for_store_orders, is_default_for_store_orders) values
          (${ids.commerceId}::uuid,${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,
           'delivery_company_registered','active',true,true)`.execute(transaction);

        await sql`insert into trader_storefronts(
            id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
          ) values(${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${ids.commerceId}::uuid,
            'Checkout Shop',${`checkout-shop-${short}`},'general','modern','published',now())`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_categories(id,company_id,storefront_id,name_en,slug)
          values(${ids.categoryId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,'General',${`general-${short}`})`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_products(
            id,company_id,storefront_id,trader_id,category_id,name,slug,product_code,selling_price,
            lifecycle_status,availability_status,minimum_quantity,maximum_quantity
          ) values(${ids.productId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.traderId}::uuid,
            ${ids.categoryId}::uuid,'Checkout Product',${`checkout-product-${short}`},${`CP-${short}`},50.00,
            'active','available',1,5)`.execute(transaction);
        await sql`insert into trader_storefront_product_option_groups(id,storefront_id,product_id,name,display_order,is_required,is_active)
          values(${ids.groupId}::uuid,${ids.storefrontId}::uuid,${ids.productId}::uuid,'Size',0,true,true)`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_product_option_values(id,storefront_id,option_group_id,value,display_order,is_active)
          values(${ids.valueId}::uuid,${ids.storefrontId}::uuid,${ids.groupId}::uuid,'Medium',0,true)`.execute(
          transaction,
        );

        // Delivery Company's own Area -- Area rows are Company-scoped
        // (`areas.company_id` NOT NULL), so this Area belongs to
        // `relationshipCompanyId`, not the Store's own Company.
        await sql`insert into areas(id,company_id,emirate_id,code,name_en,name_ar,is_active)
          values(${ids.areaId}::uuid,${ids.relationshipCompanyId}::uuid,${emirateId}::uuid,${`AB-${relShort}`},'Al Barsha','البرشاء',true)`.execute(
          transaction,
        );
        await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash)
          values(${ids.pricingCreatorAccountId}::uuid,${ids.relationshipCompanyId}::uuid,'company_user',
            ${`pricer-${relShort}`},${`pricer-${relShort}`},'x')`.execute(transaction);
        await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,reason,created_by_account_id)
          values(${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,${emirateId}::uuid,${ids.areaId}::uuid,15.00,'checkout test',${ids.pricingCreatorAccountId}::uuid)`.execute(
          transaction,
        );

        // A logged-in Customer with one saved address, plus a second
        // Customer whose address must never be reachable from the first.
        const otherCustomerAccountId = randomUUID();
        await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,mobile_number,normalized_mobile_number) values
          (${ids.customerAccountId}::uuid,null,'customer',${`checkout-customer-${short}`},${`checkout-customer-${short}`},'x','971503000010','971503000010'),
          (${otherCustomerAccountId}::uuid,null,'customer',${`checkout-other-${short}`},${`checkout-other-${short}`},'x','971503000011','971503000011')`.execute(
          transaction,
        );
        await sql`insert into commerce_customers(id,account_id,name,mobile_number)
          values(${ids.customerId}::uuid,${ids.customerAccountId}::uuid,'Checkout Customer','971503000010')`.execute(
          transaction,
        );
        await sql`insert into commerce_customers(id,account_id,name,mobile_number)
          values(${ids.otherCustomerId}::uuid,${otherCustomerAccountId}::uuid,'Other Customer','971503000011')`.execute(
          transaction,
        );
        await sql`insert into commerce_customer_addresses(id,commerce_customer_id,label,recipient_name,mobile_number,emirate,area,address,is_default)
          values(${ids.customerAddressId}::uuid,${ids.customerId}::uuid,'Home','Checkout Customer','971503000010','Dubai','Al Barsha','Street 9',true)`.execute(
          transaction,
        );
        await sql`insert into commerce_customer_addresses(id,commerce_customer_id,label,recipient_name,mobile_number,emirate,area,address,is_default)
          values(${ids.otherCustomerAddressId}::uuid,${ids.otherCustomerId}::uuid,'Home','Other Customer','971503000011','Dubai','Deira','Street 1',true)`.execute(
          transaction,
        );

        const securityContext = new RequestSecurityContextStore();
        const service = new CommerceCheckoutService(transaction, securityContext);

        const baseInput = {
          cartLines: [
            {
              productSlug: `checkout-product-${short}`,
              quantity: 2,
              selectedOptions: [{ groupName: "Size", value: "Medium" }],
            },
          ],
          customerMobile: "971503000010",
          customerName: "Checkout Customer",
          newAddress: { address: "Street 9", areaId: ids.areaId, emirateId },
          paymentMethod: "cod" as const,
          storeSlug: `checkout-shop-${short}`,
        };

        // --- guest: authoritative pricing, single eligible Company auto-selected ---
        const guestResult = await service.validate(baseInput);
        expect(guestResult.canProceed).toBe(true);
        expect(guestResult.customer.isGuest).toBe(true);
        expect(guestResult.productSubtotal).toBe("100.00"); // 50.00 x 2, decimal-safe
        expect(guestResult.selectedDeliveryCompany?.customerDeliveryFee).toBe("15.00");
        expect(guestResult.codTotal).toBe("115.00");
        expect(guestResult.deliveryOptions).toHaveLength(1);
        expect(guestResult.zeroCompanyMessage).toBeNull();

        // --- price change: source of truth is the DB, not the Cart's price ---
        await sql`update trader_storefront_products set selling_price = 60.00 where id = ${ids.productId}::uuid`.execute(
          transaction,
        );
        const repriced = await service.validate(baseInput);
        expect(repriced.lines[0]!.unitPrice).toBe("60.00");
        expect(repriced.productSubtotal).toBe("120.00");

        // --- invalid option is rejected, never silently substituted ---
        const invalidOptionResult = await service.validate({
          ...baseInput,
          cartLines: [
            {
              productSlug: `checkout-product-${short}`,
              quantity: 1,
              selectedOptions: [{ groupName: "Size", value: "Extra Large" }],
            },
          ],
        });
        expect(invalidOptionResult.canProceed).toBe(false);
        expect(invalidOptionResult.lines[0]!.valid).toBe(false);

        // --- invalid quantity ---
        const invalidQuantityResult = await service.validate({
          ...baseInput,
          cartLines: [
            {
              productSlug: `checkout-product-${short}`,
              quantity: 99,
              selectedOptions: [{ groupName: "Size", value: "Medium" }],
            },
          ],
        });
        expect(invalidQuantityResult.lines[0]!.valid).toBe(false);
        expect(invalidQuantityResult.lines[0]!.issue).toContain("quantity");

        // --- unknown product slug ---
        const unknownProductResult = await service.validate({
          ...baseInput,
          cartLines: [{ productSlug: "does-not-exist", quantity: 1, selectedOptions: [] }],
        });
        expect(unknownProductResult.lines[0]!.valid).toBe(false);

        // --- Store closed: business error, not a crash ---
        await sql`update trader_storefronts set status = 'temporarily_closed' where id = ${ids.storefrontId}::uuid`.execute(
          transaction,
        );
        await expect(service.validate(baseInput)).rejects.toMatchObject({ status: 409 });
        await sql`update trader_storefronts set status = 'published' where id = ${ids.storefrontId}::uuid`.execute(
          transaction,
        );

        // --- logged-in Customer: saved address, ownership-verified ---
        const { newAddress: _unusedAddress, ...baseInputWithoutAddress } = baseInput;
        const loggedInInput = {
          ...baseInputWithoutAddress,
          savedAddressId: ids.customerAddressId,
        };
        const loggedInResult = await securityContext.run(
          {
            identity: {
              companyId: null,
              forcePasswordChange: false,
              identityId: ids.customerAccountId,
              kind: "customer" as const,
              permissions: new Set<string>(),
              sessionId: randomUUID(),
            },
            tenant: undefined,
          },
          () => service.validate(loggedInInput),
        );
        expect(loggedInResult.customer.isGuest).toBe(false);
        expect(loggedInResult.address.area).toBe("Al Barsha");

        // --- a foreign saved address is rejected, never leaked ---
        await expect(
          securityContext.run(
            {
              identity: {
                companyId: null,
                forcePasswordChange: false,
                identityId: ids.customerAccountId,
                kind: "customer" as const,
                permissions: new Set<string>(),
                sessionId: randomUUID(),
              },
              tenant: undefined,
            },
            () =>
              service.validate({
                ...baseInputWithoutAddress,
                savedAddressId: ids.otherCustomerAddressId,
              }),
          ),
        ).rejects.toMatchObject({ status: 404 });

        // --- zero eligible Delivery Company: still reaches review ---
        await sql`update trader_delivery_company_relationships set enabled_for_store_orders = false, is_default_for_store_orders = false
          where trader_commerce_id = ${ids.commerceId}::uuid`.execute(transaction);
        const zeroCompanyResult = await service.validate(baseInput);
        expect(zeroCompanyResult.canProceed).toBe(true);
        expect(zeroCompanyResult.selectedDeliveryCompany).toBeNull();
        expect(zeroCompanyResult.customerDeliveryFee).toBe("0.00");
        expect(zeroCompanyResult.zeroCompanyMessage).not.toBeNull();
        expect(zeroCompanyResult.zeroCompanyMessage).not.toContain("awaiting_trader_confirmation");

        // --- safe response shape: no internal Trader id leaked (Company id
        // itself IS exposed for selection, by design -- §76) ---
        const serialized = JSON.stringify(guestResult);
        expect(serialized).not.toContain(ids.relationshipTraderId);

        // --- Pre-production fix: structured Area is validated, never
        // guessed. A nonexistent areaId is a normal 400, not a crash and
        // never a fabricated match. ---
        await sql`update trader_delivery_company_relationships set enabled_for_store_orders = true, is_default_for_store_orders = true
          where trader_commerce_id = ${ids.commerceId}::uuid`.execute(transaction);
        await expect(
          service.validate({
            ...baseInput,
            newAddress: { address: "Street 9", areaId: randomUUID(), emirateId },
          }),
        ).rejects.toMatchObject({ errorCode: "checkout_area_invalid", status: 400 });

        // --- an Area id that exists but belongs to a DIFFERENT Emirate is
        // rejected the same way -- never silently reassigned to the
        // submitted Emirate. ---
        const abuDhabi = await sql<{
          id: string;
        }>`select id from emirates where name_en = 'Abu Dhabi'`.execute(transaction);
        await expect(
          service.validate({
            ...baseInput,
            newAddress: {
              address: "Street 9",
              areaId: ids.areaId,
              emirateId: abuDhabi.rows[0]!.id,
            },
          }),
        ).rejects.toMatchObject({ errorCode: "checkout_area_invalid", status: 400 });

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
