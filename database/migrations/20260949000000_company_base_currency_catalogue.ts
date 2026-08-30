import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Expands currency allow-lists only. Monetary column precision remains unchanged. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_settings drop constraint company_settings_currency_aed,
      add constraint company_settings_currency_supported check(base_currency in(
        'AED','SAR','QAR','USD','EUR','GBP','KWD','BHD','OMR','JOD','EGP','SYP','LBP',
        'IQD','YER','MAD','DZD','TND','LYD','SDG','SOS','DJF','KMF','MRU'));
    alter table chart_of_accounts drop constraint chart_of_accounts_currency_check,
      add constraint chart_of_accounts_currency_check check(currency in(
        'AED','SAR','QAR','USD','EUR','GBP','KWD','BHD','OMR','JOD','EGP','SYP','LBP',
        'IQD','YER','MAD','DZD','TND','LYD','SDG','SOS','DJF','KMF','MRU'));
    alter table accounting_configurations drop constraint accounting_configurations_currency_check,
      add constraint accounting_configurations_currency_check check(base_currency in(
        'AED','SAR','QAR','USD','EUR','GBP','KWD','BHD','OMR','JOD','EGP','SYP','LBP',
        'IQD','YER','MAD','DZD','TND','LYD','SDG','SOS','DJF','KMF','MRU'));
    alter table company_cash_accounts drop constraint company_cash_accounts_currency_check,
      add constraint company_cash_accounts_currency_check check(currency in(
        'AED','SAR','QAR','USD','EUR','GBP','KWD','BHD','OMR','JOD','EGP','SYP','LBP',
        'IQD','YER','MAD','DZD','TND','LYD','SDG','SOS','DJF','KMF','MRU'));
    alter table company_bank_accounts drop constraint company_bank_accounts_currency_aed,
      add constraint company_bank_accounts_currency_supported check(currency in(
        'AED','SAR','QAR','USD','EUR','GBP','KWD','BHD','OMR','JOD','EGP','SYP','LBP',
        'IQD','YER','MAD','DZD','TND','LYD','SDG','SOS','DJF','KMF','MRU'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  const nonAed = await sql<{ used: boolean }>`select exists(
    select 1 from company_settings where base_currency<>'AED'
  ) as used`.execute(database);
  if (nonAed.rows[0]?.used) throw new Error("Cannot restore AED-only rules while non-AED Companies exist");
  await sql`
    alter table company_settings drop constraint company_settings_currency_supported,
      add constraint company_settings_currency_aed check(base_currency='AED');
    alter table chart_of_accounts drop constraint chart_of_accounts_currency_check,
      add constraint chart_of_accounts_currency_check check(currency='AED');
    alter table accounting_configurations drop constraint accounting_configurations_currency_check,
      add constraint accounting_configurations_currency_check check(base_currency='AED');
    alter table company_cash_accounts drop constraint company_cash_accounts_currency_check,
      add constraint company_cash_accounts_currency_check check(currency='AED');
    alter table company_bank_accounts drop constraint company_bank_accounts_currency_supported,
      add constraint company_bank_accounts_currency_aed check(currency='AED');
  `.execute(database);
}
