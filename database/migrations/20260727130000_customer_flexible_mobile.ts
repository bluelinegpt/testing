import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Fast Create Order needs to capture a Customer at speed with a mobile number
 * that is only *advised* to follow the UAE format. The original schema pinned
 * `customers.mobile_number` to `^9715[0-9]{8}$`, which blocked international and
 * differently-formatted numbers and forced normalization on storage.
 *
 * This migration relaxes storage to flexible text (still required, bounded, and
 * free of control characters) and moves UAE-equivalence matching from the stored
 * value to a deterministic, IMMUTABLE comparison key so duplicate detection keeps
 * recognising `0506468442`, `971506468442` and `+971 50 646 8442` as the same
 * number without rewriting any stored value. Existing canonical rows satisfy the
 * new safe constraints unchanged, and `down()` restores the strict format checks.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- Deterministic comparison key: strip formatting to digits, then fold the
    -- UAE local/no-trunk forms onto the canonical 9715XXXXXXXX so equivalent
    -- numbers collide for duplicate detection. Non-UAE numbers keep their digits
    -- (plus any country code), so distinct international numbers do not collide.
    create function customer_mobile_comparison_key(mobile text) returns text
    language sql immutable as $$
      select case
        when digits ~ '^05[0-9]{8}$' then '971' || substr(digits, 2)
        when digits ~ '^5[0-9]{8}$' then '971' || digits
        else digits
      end
      from (select regexp_replace(coalesce($1, ''), '[^0-9]', '', 'g') as digits) source
    $$;

    alter table customers
      drop constraint customers_mobile_format,
      drop constraint customers_second_mobile_format,
      add constraint customers_mobile_safe check (
        btrim(mobile_number) <> ''
        and char_length(mobile_number) <= 32
        and mobile_number !~ '[[:cntrl:]]'
      ),
      add constraint customers_second_mobile_safe check (
        second_mobile_number is null
        or (
          btrim(second_mobile_number) <> ''
          and char_length(second_mobile_number) <= 32
          and second_mobile_number !~ '[[:cntrl:]]'
        )
      );

    -- Functional indexes on the comparison key so duplicate lookups stay indexed
    -- regardless of Customer volume. The raw-text mobile indexes remain for the
    -- substring search endpoint.
    create index customers_mobile_comparison_index
      on customers (company_id, customer_mobile_comparison_key(mobile_number));
    create index customers_second_mobile_comparison_index
      on customers (company_id, customer_mobile_comparison_key(second_mobile_number))
      where second_mobile_number is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists customers_second_mobile_comparison_index;
    drop index if exists customers_mobile_comparison_index;

    alter table customers
      drop constraint if exists customers_mobile_safe,
      drop constraint if exists customers_second_mobile_safe,
      add constraint customers_mobile_format check (mobile_number ~ '^9715[0-9]{8}$'),
      add constraint customers_second_mobile_format check (
        second_mobile_number is null or second_mobile_number ~ '^9715[0-9]{8}$'
      );

    drop function if exists customer_mobile_comparison_key(text);
  `.execute(database);
}
