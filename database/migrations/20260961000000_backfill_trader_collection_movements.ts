import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * `confirmCollection` (Trader Receivable / Collect Money from Trader) posted
 * its Journal Entry correctly from the day it shipped, but never wrote the
 * operational `cash_bank_movements` row alongside it -- the gap fixed in
 * `trader-receivable.service.ts`'s `createCollectionMovement`. Every
 * confirmed collection created before that fix is missing its Movement, so
 * money the Company actually received never appeared in the Cashbook or
 * Cash and Bank Movements screens even though the ledger was correct.
 *
 * Mirrors `20260935000000_backfill_outsourced_driver_payment_movements`'s
 * shape: a deposit has no source account, only the destination that
 * actually received the money -- the Company cash account recorded on the
 * cash collection, or the Company bank account recorded on a bank transfer
 * one.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const missing = await sql<{
    actorId: string;
    amount: string;
    bankAccountId: string | null;
    cashAccountId: string | null;
    collectionId: string;
    collectionNumber: string;
    companyId: string;
    eventId: string;
    paymentDate: string;
    paymentMethod: "bank_transfer" | "cash";
  }>`
    select c.received_by_account_id as "actorId",c.amount_received::text as amount,
           c.company_bank_account_id as "bankAccountId",
           (select a.id from company_cash_accounts a
             where a.company_id=c.company_id and a.is_active and a.cash_account_type='main_cash'
             order by a.created_at asc limit 1) as "cashAccountId",
           c.id as "collectionId",c.collection_number as "collectionNumber",
           c.company_id as "companyId",e.id as "eventId",
           c.payment_date::text as "paymentDate",c.payment_method as "paymentMethod"
      from trader_collections c
      join accounting_events e on e.company_id=c.company_id
       and e.source_entity_type='trader_collection'
       and e.source_entity_id=c.id and e.event_type='trader_receivable_payment_received'
     where c.status='confirmed'
       and not exists (
         select 1 from cash_bank_movements m
          where m.company_id=c.company_id
            and m.correlation_id=c.id::text
            and m.movement_type in ('cash_deposit','bank_deposit')
       )
     order by c.company_id,c.payment_date,c.confirmed_at,c.id
  `.execute(database);

  for (const collection of missing.rows) {
    const isCash = collection.paymentMethod === "cash";
    // A cash collection with no active main Cash account configured cannot
    // be backfilled -- the live code path would refuse to confirm it today
    // for the same reason. Leave it for manual review rather than guessing
    // a destination account.
    if (isCash && collection.cashAccountId === null) continue;

    const counter = await sql<{ movementNumber: string }>`
      insert into company_reference_counters(company_id,reference_type,next_value,prefix)
      values(${collection.companyId}::uuid,'cash_bank_movement',2,'CBM')
      on conflict(company_id,reference_type) do update
        set next_value=company_reference_counters.next_value+1,updated_at=now()
      returning prefix||'-'||lpad((next_value-1)::text,6,'0') as "movementNumber"
    `.execute(database);
    const movementNumber = counter.rows[0]!.movementNumber;

    await sql`
      insert into cash_bank_movements(
        id,company_id,movement_number,movement_type,movement_date,accounting_date,
        destination_cash_account_id,destination_bank_account_id,
        amount,fee_amount,payment_method,reference_number,description,status,
        correlation_id,idempotency_identity,accounting_event_id,
        confirmed_by_account_id,confirmed_at,created_by_account_id,created_at
      ) values(
        ${randomUUID()}::uuid,${collection.companyId}::uuid,${movementNumber},
        ${isCash ? "cash_deposit" : "bank_deposit"},${collection.paymentDate}::date,
        ${collection.paymentDate}::date,
        ${isCash ? collection.cashAccountId : null}::uuid,
        ${isCash ? null : collection.bankAccountId}::uuid,
        ${collection.amount}::numeric,0,${isCash ? "cash" : "visa"},
        ${collection.collectionNumber},${`Trader collection ${collection.collectionNumber}`},
        'confirmed',${collection.collectionId},
        ${`${collection.collectionNumber}_${movementNumber}`},${collection.eventId}::uuid,
        ${collection.actorId}::uuid,now(),${collection.actorId}::uuid,now()
      )
    `.execute(database);
  }
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  void database;
  throw new Error(
    "This financial movement backfill is forward-only; restore the verified pre-migration backup instead",
  );
}
