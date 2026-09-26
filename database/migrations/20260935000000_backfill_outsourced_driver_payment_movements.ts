import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const missing = await sql<{
    actorId: string;
    amount: string;
    cashAccountId: string;
    companyId: string;
    eventId: string;
    paymentDate: string;
    paymentId: string;
    paymentNumber: string;
  }>`
    select p.paid_by_account_id as "actorId",p.amount_paid::text as amount,
           p.company_cash_account_id as "cashAccountId",p.company_id as "companyId",
           e.id as "eventId",p.payment_date::text as "paymentDate",p.id as "paymentId",
           p.payment_number as "paymentNumber"
      from outsourced_driver_fee_payments p
      join accounting_events e on e.company_id=p.company_id
       and e.source_entity_type='outsourced_driver_fee_payment'
       and e.source_entity_id=p.id and e.event_type='outsourced_driver_fee_paid'
     where p.status='confirmed' and p.payment_source='separate_payment'
       and p.payment_method='cash' and p.company_cash_account_id is not null
       and not exists (
         select 1 from cash_bank_movements m
          where m.company_id=p.company_id
            and m.idempotency_identity='outsourced_driver_fee_payment:'||p.id::text
       )
     order by p.company_id,p.payment_date,p.confirmed_at,p.id
  `.execute(database);

  for (const payment of missing.rows) {
    const counter = await sql<{ movementNumber: string }>`
      insert into company_reference_counters(company_id,reference_type,next_value,prefix)
      values(${payment.companyId}::uuid,'cash_bank_movement',2,'CBM')
      on conflict(company_id,reference_type) do update
        set next_value=company_reference_counters.next_value+1,updated_at=now()
      returning prefix||'-'||lpad((next_value-1)::text,6,'0') as "movementNumber"
    `.execute(database);
    await sql`
      insert into cash_bank_movements(
        id,company_id,movement_number,movement_type,movement_date,accounting_date,
        source_cash_account_id,amount,fee_amount,payment_method,reference_number,
        description,status,correlation_id,idempotency_identity,accounting_event_id,
        confirmed_by_account_id,confirmed_at,created_by_account_id,created_at
      ) values(
        ${randomUUID()}::uuid,${payment.companyId}::uuid,
        ${counter.rows[0]!.movementNumber},'cash_withdrawal',${payment.paymentDate}::date,
        ${payment.paymentDate}::date,${payment.cashAccountId}::uuid,${payment.amount}::numeric,
        0,'cash',${payment.paymentNumber},${`Outsourced Driver fee payment ${payment.paymentNumber}`},
        'confirmed',${payment.paymentId},${`outsourced_driver_fee_payment:${payment.paymentId}`},
        ${payment.eventId}::uuid,${payment.actorId}::uuid,now(),${payment.actorId}::uuid,now()
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
