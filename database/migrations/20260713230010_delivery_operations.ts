import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table areas (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name_en text not null,
      name_ar text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deactivated_at timestamptz,
      version bigint not null default 1,
      unique (id, company_id),
      constraint areas_code_nonempty check (btrim(code) <> ''),
      constraint areas_version_positive check (version > 0)
    );
    create unique index areas_code_unique on areas (company_id, lower(code));
    create unique index areas_name_en_unique on areas (company_id, lower(name_en));

    create table traders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      account_id uuid not null,
      code text not null,
      name_en text not null,
      name_ar text,
      contact_person text,
      mobile_number text not null,
      telephone text,
      email text,
      address_en text,
      address_ar text,
      pickup_address text,
      account_status text not null default 'active',
      notes text,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (account_id),
      constraint traders_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint traders_status_check check (account_status in ('active', 'disabled')),
      constraint traders_code_nonempty check (btrim(code) <> ''),
      constraint traders_mobile_nonempty check (btrim(mobile_number) <> ''),
      constraint traders_version_positive check (version > 0)
    );
    create unique index traders_code_unique on traders (company_id, lower(code));
    create index traders_company_status_index on traders (company_id, account_status);

    create table trader_pricing (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      pricing_method text not null,
      flat_service_fee numeric(18,2),
      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint trader_pricing_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_pricing_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_pricing_method_check check (pricing_method in ('flat', 'by_area')),
      constraint trader_pricing_flat_fee_check check (
        (pricing_method = 'flat' and flat_service_fee is not null and flat_service_fee >= 0)
        or (pricing_method = 'by_area' and flat_service_fee is null)
      ),
      constraint trader_pricing_dates_check check (effective_to is null or effective_to >= effective_from),
      constraint trader_pricing_version_positive check (version > 0)
    );
    create unique index trader_pricing_active_unique
      on trader_pricing (company_id, trader_id) where is_active;

    create table trader_area_prices (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_pricing_id uuid not null,
      area_id uuid not null,
      service_fee numeric(18,2) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, trader_pricing_id, area_id),
      constraint trader_area_prices_pricing_fk foreign key (trader_pricing_id, company_id)
        references trader_pricing(id, company_id) on delete restrict,
      constraint trader_area_prices_area_fk foreign key (area_id, company_id)
        references areas(id, company_id) on delete restrict,
      constraint trader_area_prices_fee_nonnegative check (service_fee >= 0),
      constraint trader_area_prices_version_positive check (version > 0)
    );

    create table vehicles (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      registration_number text not null,
      make text,
      model text,
      color text,
      notes text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint vehicles_version_positive check (version > 0)
    );
    create unique index vehicles_registration_unique
      on vehicles (company_id, lower(registration_number));

    create table drivers (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      account_id uuid not null,
      employee_id uuid,
      vehicle_id uuid,
      code text not null,
      name_en text not null,
      name_ar text,
      mobile_number text not null,
      address text,
      driver_type text not null,
      account_status text not null default 'active',
      commission_type text,
      commission_value numeric(18,2),
      outsourced_fee_per_delivered_order numeric(18,2),
      notes text,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (account_id),
      constraint drivers_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint drivers_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint drivers_vehicle_fk foreign key (vehicle_id, company_id)
        references vehicles(id, company_id) on delete restrict,
      constraint drivers_type_check check (driver_type in ('employee', 'outsourced')),
      constraint drivers_employee_consistency check (
        (driver_type = 'employee' and employee_id is not null and outsourced_fee_per_delivered_order is null)
        or (driver_type = 'outsourced' and employee_id is null and commission_type is null and commission_value is null
          and outsourced_fee_per_delivered_order is not null)
      ),
      constraint drivers_commission_type_check check (commission_type is null or commission_type in ('fixed', 'percentage')),
      constraint drivers_commission_consistency check (
        (commission_type is null and commission_value is null)
        or (commission_type is not null and commission_value is not null and commission_value >= 0)
      ),
      constraint drivers_percentage_check check (commission_type <> 'percentage' or commission_value <= 100),
      constraint drivers_outsourced_fee_check check (outsourced_fee_per_delivered_order is null or outsourced_fee_per_delivered_order >= 0),
      constraint drivers_status_check check (account_status in ('active', 'disabled')),
      constraint drivers_mobile_nonempty check (btrim(mobile_number) <> ''),
      constraint drivers_version_positive check (version > 0)
    );
    create unique index drivers_code_unique on drivers (company_id, lower(code));
    create index drivers_company_type_status_index on drivers (company_id, driver_type, account_status);

    create table driver_documents (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      document_type text not null,
      document_number text,
      expiry_date date,
      attachment_file_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, driver_id, document_type),
      constraint driver_documents_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint driver_documents_file_fk foreign key (attachment_file_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint driver_documents_type_check check (document_type in ('passport', 'emirates_id', 'driving_license')),
      constraint driver_documents_version_positive check (version > 0)
    );
    create index driver_documents_expiry_index on driver_documents (company_id, expiry_date)
      where expiry_date is not null;

    create table third_party_delivery_companies (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      name text not null,
      contact_information text,
      address text,
      default_cost numeric(18,2),
      notes text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint third_party_delivery_cost_check check (default_cost is null or default_cost >= 0),
      constraint third_party_delivery_version_positive check (version > 0)
    );
    create unique index third_party_delivery_name_unique
      on third_party_delivery_companies (company_id, lower(name));

    create table import_batches (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      import_number text not null,
      import_type text not null,
      trader_id uuid,
      source_file_id uuid not null,
      template_version text not null,
      status text not null default 'uploaded',
      total_rows integer not null default 0,
      valid_rows integer not null default 0,
      invalid_rows integer not null default 0,
      imported_rows integer not null default 0,
      requested_by_account_id uuid not null,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, import_number),
      constraint import_batches_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint import_batches_file_fk foreign key (source_file_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint import_batches_requester_fk foreign key (requested_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint import_batches_type_check check (import_type in ('orders', 'traders', 'drivers')),
      constraint import_batches_status_check check (status in ('uploaded', 'validating', 'rejected', 'validated', 'importing', 'completed', 'failed')),
      constraint import_batches_counts_check check (
        total_rows >= 0 and valid_rows >= 0 and invalid_rows >= 0 and imported_rows >= 0
        and valid_rows + invalid_rows <= total_rows and imported_rows <= valid_rows
      )
    );
    create index import_batches_company_created_index on import_batches (company_id, created_at desc);

    create table import_errors (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      import_batch_id uuid not null,
      row_number integer not null,
      column_name text not null,
      error_code text not null,
      message text not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint import_errors_batch_fk foreign key (import_batch_id, company_id)
        references import_batches(id, company_id) on delete restrict,
      constraint import_errors_row_positive check (row_number > 0)
    );
    create index import_errors_batch_row_index on import_errors (company_id, import_batch_id, row_number);

    create table orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_number text not null,
      order_date date not null,
      trader_id uuid not null,
      area_id uuid not null,
      created_by_account_id uuid not null,
      import_batch_id uuid,
      assigned_driver_id uuid,
      delivery_mode text not null default 'internal',
      customer_name text not null,
      customer_mobile_number text not null,
      customer_second_mobile_number text,
      customer_address text not null,
      customer_latitude numeric(9,6),
      customer_longitude numeric(9,6),
      package_count integer not null,
      notes text,
      payment_condition text not null,
      cod_amount numeric(18,2) not null default 0,
      service_fee numeric(18,2) not null default 0,
      customer_charges numeric(18,2) not null default 0,
      customer_credits_refunds numeric(18,2) not null default 0,
      customer_amount_due numeric(18,2) not null default 0,
      amount_collected numeric(18,2) not null default 0,
      trader_gross_payable numeric(18,2) not null default 0,
      trader_paid_service_fee numeric(18,2) not null default 0,
      trader_deductions numeric(18,2) not null default 0,
      trader_charges numeric(18,2) not null default 0,
      trader_adjustments numeric(18,2) not null default 0,
      trader_net_payable numeric(18,2) not null default 0,
      driver_cost numeric(18,2) not null default 0,
      return_driver_fee numeric(18,2) not null default 0,
      order_expenses_total numeric(18,2) not null default 0,
      company_other_charges numeric(18,2) not null default 0,
      revenue_adjustments numeric(18,2) not null default 0,
      vat_amount numeric(18,2) not null default 0,
      company_revenue numeric(18,2) not null default 0,
      order_profit numeric(18,2) not null default 0,
      delivery_status text not null default 'new',
      delivery_reason text,
      driver_reconciliation_status text not null default 'not_applicable',
      trader_settlement_status text not null default 'not_eligible',
      return_status text not null default 'not_applicable',
      accounting_status text not null default 'unposted',
      expected_delivery_date date,
      delivered_at timestamptz,
      closed_at timestamptz,
      submitted_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, order_number),
      constraint orders_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint orders_area_fk foreign key (area_id, company_id)
        references areas(id, company_id) on delete restrict,
      constraint orders_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint orders_import_batch_fk foreign key (import_batch_id, company_id)
        references import_batches(id, company_id) on delete restrict,
      constraint orders_driver_fk foreign key (assigned_driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint orders_delivery_mode_check check (delivery_mode in ('internal', 'international')),
      constraint orders_international_driver_check check (delivery_mode = 'internal' or assigned_driver_id is null),
      constraint orders_payment_condition_check check (payment_condition in (
        'customer_pays_cod_and_fee',
        'customer_pays_cod_trader_pays_fee',
        'prepaid_customer_pays_fee',
        'prepaid_trader_pays_fee'
      )),
      constraint orders_package_count_positive check (package_count > 0),
      constraint orders_coordinates_check check (
        (customer_latitude is null and customer_longitude is null)
        or (customer_latitude between -90 and 90 and customer_longitude between -180 and 180)
      ),
      constraint orders_nonnegative_amounts check (
        cod_amount >= 0 and service_fee >= 0 and customer_charges >= 0
        and customer_credits_refunds >= 0 and customer_amount_due >= 0 and amount_collected >= 0
        and trader_gross_payable >= 0 and trader_paid_service_fee >= 0 and trader_deductions >= 0
        and trader_charges >= 0 and trader_net_payable >= 0 and driver_cost >= 0
        and return_driver_fee >= 0 and order_expenses_total >= 0 and company_other_charges >= 0
        and vat_amount >= 0
      ),
      constraint orders_delivery_status_check check (delivery_status in ('new', 'processing', 'assigned', 'out_for_delivery', 'delivered', 'returned', 'cancelled')),
      constraint orders_reconciliation_status_check check (driver_reconciliation_status in ('not_applicable', 'pending', 'reconciled', 'reversed')),
      constraint orders_settlement_status_check check (trader_settlement_status in ('not_eligible', 'unsettled', 'settled', 'reversed')),
      constraint orders_return_status_check check (return_status in ('not_applicable', 'returned_to_branch', 'returned_to_trader')),
      constraint orders_accounting_status_check check (accounting_status in ('unposted', 'posted', 'reversed')),
      constraint orders_close_return_check check (
        closed_at is null or (return_status <> 'returned_to_branch' and (delivery_status <> 'returned' or return_status = 'returned_to_trader'))
      ),
      constraint orders_version_positive check (version > 0)
    );
    create index orders_company_status_date_index on orders (company_id, delivery_status, order_date desc);
    create index orders_company_trader_date_index on orders (company_id, trader_id, order_date desc);
    create index orders_company_driver_status_index on orders (company_id, assigned_driver_id, delivery_status)
      where assigned_driver_id is not null;
    create index orders_company_reconciliation_index on orders (company_id, driver_reconciliation_status, delivered_at);
    create index orders_company_settlement_index on orders (company_id, trader_settlement_status, delivered_at);
    create index orders_customer_mobile_index on orders (company_id, customer_mobile_number);

    create table order_items (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      description text,
      quantity numeric(12,3) not null default 1,
      package_count integer,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint order_items_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_items_quantity_positive check (quantity > 0),
      constraint order_items_package_count_positive check (package_count is null or package_count > 0)
    );
    create index order_items_order_index on order_items (company_id, order_id);

    create table order_assignments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      driver_id uuid not null,
      assigned_by_account_id uuid not null,
      assigned_at timestamptz not null default now(),
      unassigned_at timestamptz,
      reason text,
      unique (id, company_id),
      constraint order_assignments_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_assignments_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint order_assignments_actor_fk foreign key (assigned_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_assignments_dates_check check (unassigned_at is null or unassigned_at >= assigned_at)
    );
    create unique index order_assignments_active_unique
      on order_assignments (company_id, order_id) where unassigned_at is null;
    create index order_assignments_driver_index on order_assignments (company_id, driver_id, assigned_at desc);

    create table order_status_history (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      status_dimension text not null,
      from_status text,
      to_status text not null,
      reason text,
      changed_by_account_id uuid not null,
      occurred_at timestamptz not null default now(),
      unique (id, company_id),
      constraint order_status_history_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_status_history_actor_fk foreign key (changed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_status_history_dimension_check check (status_dimension in ('delivery', 'driver_reconciliation', 'trader_settlement', 'return', 'accounting'))
    );
    create index order_status_history_order_time_index on order_status_history (company_id, order_id, occurred_at);

    create table order_attachments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      file_object_id uuid not null,
      attachment_type text not null,
      uploaded_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint order_attachments_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_attachments_file_fk foreign key (file_object_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint order_attachments_actor_fk foreign key (uploaded_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_attachments_type_check check (attachment_type in ('delivery_photo', 'expense', 'waybill', 'other'))
    );

    create table international_shipments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      third_party_delivery_company_id uuid not null,
      provider_reference_number text,
      destination_country_code char(2) not null,
      international_delivery_cost numeric(18,2) not null default 0,
      customer_charge numeric(18,2) not null default 0,
      shipment_date date,
      expected_delivery_date date,
      delivery_date date,
      current_status text not null,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (order_id),
      constraint international_shipments_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint international_shipments_provider_fk foreign key (third_party_delivery_company_id, company_id)
        references third_party_delivery_companies(id, company_id) on delete restrict,
      constraint international_shipments_amounts_check check (international_delivery_cost >= 0 and customer_charge >= 0),
      constraint international_shipments_dates_check check (
        (expected_delivery_date is null or shipment_date is null or expected_delivery_date >= shipment_date)
        and (delivery_date is null or shipment_date is null or delivery_date >= shipment_date)
      ),
      constraint international_shipments_version_positive check (version > 0)
    );

    create table tracking_tokens (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      token_hash text not null,
      expires_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      last_accessed_at timestamptz,
      unique (id, company_id),
      unique (token_hash),
      constraint tracking_tokens_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint tracking_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint tracking_tokens_expiry_check check (expires_at is null or expires_at > created_at)
    );
    create index tracking_tokens_order_index on tracking_tokens (company_id, order_id);

    create table tracking_access_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      tracking_token_id uuid not null,
      response_status integer not null,
      ip_address inet,
      accessed_at timestamptz not null default now(),
      unique (id, company_id),
      constraint tracking_access_events_token_fk foreign key (tracking_token_id, company_id)
        references tracking_tokens(id, company_id) on delete restrict,
      constraint tracking_access_events_status_check check (response_status between 100 and 599)
    );
    create index tracking_access_events_token_time_index on tracking_access_events (company_id, tracking_token_id, accessed_at desc);

    create table saas_usage_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      event_type text not null default 'order_submitted',
      occurred_at timestamptz not null,
      billing_period_start date not null,
      idempotency_key text not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, order_id, event_type),
      unique (company_id, idempotency_key),
      constraint saas_usage_events_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint saas_usage_events_type_check check (event_type = 'order_submitted')
    );
    create index saas_usage_events_company_period_index on saas_usage_events (company_id, billing_period_start, occurred_at);
  `.execute(database);
}
