import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { ensureStylistProfilesForActiveStaff } from "./repository.js"

export const ensureBookingsSchema = createSchemaEnsurer({
  name: "bookings",
  async migrate(client) {
    // Owned by auth/schema-init.js (constraint, default, backfill); repeated here
    // only so a cold boot that hits a booking route first still finds the column.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(16) NOT NULL DEFAULT 'UNSPECIFIED'`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_name_enc TEXT,
        customer_email VARCHAR(255),
        customer_email_enc TEXT,
        customer_phone VARCHAR(32),
        customer_phone_enc TEXT,
        service_name VARCHAR(255) NOT NULL,
        stylist_id UUID REFERENCES users(id) ON DELETE SET NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        service_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        payable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
        invoice_number VARCHAR(64),
        actual_start_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        overtime_minutes INTEGER NOT NULL DEFAULT 0,
        penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_starts_at_idx ON bookings(starts_at)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status)
    `)
    // "Remove from my history" hides a booking from its customer; the row, its payments and
    // its invoice stay (financial records, complaints and first-booking history depend on them).
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hidden_from_customer_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email_enc TEXT`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(32)`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone_enc TEXT`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stylist_id UUID REFERENCES users(id) ON DELETE SET NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS bookings_stylist_id_idx ON bookings(stylist_id)`)
    // Lookup paths that had no index and degraded to full scans as `bookings` grew
    // (measured at 300k rows: customer list 0.45-0.7 s, first-booking check 270 ms):
    //  - the customer portal finds "my bookings" by e-mail OR phone,
    //  - first-booking / referral checks count by `created_by`,
    //  - the admin list orders by `created_at DESC, id DESC`.
    await client.query(`CREATE INDEX IF NOT EXISTS bookings_customer_email_lower_idx ON bookings (lower(customer_email))`)
    await client.query(`CREATE INDEX IF NOT EXISTS bookings_customer_phone_idx ON bookings (customer_phone)`)
    await client.query(`CREATE INDEX IF NOT EXISTS bookings_created_by_idx ON bookings (created_by)`)
    await client.query(`CREATE INDEX IF NOT EXISTS bookings_created_at_id_idx ON bookings (created_at DESC NULLS LAST, id DESC)`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_items_json JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payable_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(64)`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS actual_start_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overtime_minutes INTEGER NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'CONFIRMED'`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_catalog (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        category VARCHAR(64) NOT NULL DEFAULT 'GENERAL',
        target_gender VARCHAR(16) NOT NULL DEFAULT 'UNISEX',
        base_price NUMERIC(12,2) NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        description TEXT,
        image_url TEXT,
        variants_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS category VARCHAR(64) NOT NULL DEFAULT 'GENERAL'`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS target_gender VARCHAR(16) NOT NULL DEFAULT 'UNISEX'`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 45`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS description TEXT`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS image_url TEXT`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS variants_json JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL`)
    // Member (Premium) price for single-price services; variants carry their own `memberPrice`.
    // NULL = no member rate published ("NA" on the menu), never 0.
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS member_price NUMERIC(12,2)`)
    // Duration is not read from the printed menu; new services start at 30 min and are tuned in admin.
    await client.query(`ALTER TABLE service_catalog ALTER COLUMN duration_minutes SET DEFAULT 30`)
    // Long-form "service details" sections and extra photos (see bookings/service-details.js).
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS details_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS gallery_json JSONB NOT NULL DEFAULT '[]'::jsonb`)
    // The customer catalog is `WHERE is_active ORDER BY name`; a partial index serves it without a sort.
    await client.query(`CREATE INDEX IF NOT EXISTS service_catalog_active_name_idx ON service_catalog (name) WHERE is_active = TRUE`)
    await client.query(`CREATE INDEX IF NOT EXISTS service_catalog_category_idx ON service_catalog (category)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stylist_service_map (
        id UUID PRIMARY KEY,
        stylist_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(stylist_id, service_id)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS stylist_service_map_service_id_idx ON stylist_service_map (service_id)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stylist_profiles (
        stylist_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        target_segment VARCHAR(16) NOT NULL DEFAULT 'UNISEX',
        working_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`ALTER TABLE stylist_profiles ADD COLUMN IF NOT EXISTS working_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE stylist_profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stylist_shift_windows (
        id UUID PRIMARY KEY,
        stylist_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_start VARCHAR(8) NOT NULL DEFAULT '08:00',
        shift_end VARCHAR(8) NOT NULL DEFAULT '23:00',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(stylist_id)
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stylist_leaves (
        id UUID PRIMARY KEY,
        stylist_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_start DATE NOT NULL,
        leave_end DATE NOT NULL,
        note TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS stylist_leaves_lookup_idx ON stylist_leaves(stylist_id, leave_start, leave_end)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_payroll_policy (
        id UUID PRIMARY KEY,
        grace_minutes INTEGER NOT NULL DEFAULT 10,
        penalty_per_minute NUMERIC(12,2) NOT NULL DEFAULT 0,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id UUID PRIMARY KEY,
        booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
        source_type VARCHAR(16) NOT NULL DEFAULT 'BOOKING',
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255),
        customer_phone VARCHAR(32),
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        payment_mode VARCHAR(32) NOT NULL,
        collected_by UUID REFERENCES users(id) ON DELETE SET NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Every booking list/queue query sums payments per booking with a correlated subselect.
    // Without this index each of those is a sequential scan of the whole payments table,
    // once per booking row returned (admin list: 5.5 s at 315k payments; now ~10 ms).
    await client.query(`CREATE INDEX IF NOT EXISTS payment_transactions_booking_id_idx ON payment_transactions(booking_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS payment_transactions_collected_at_idx ON payment_transactions(collected_at)`)
    await client.query(`CREATE INDEX IF NOT EXISTS payment_transactions_mode_idx ON payment_transactions(payment_mode)`)
    // Backstop for concurrent cancels: at most one refund row per booking. Skipped (not
    // failed) if historic data already holds duplicates, so a boot never breaks on it.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM payment_transactions
          WHERE source_type = 'REFUND' AND booking_id IS NOT NULL
          GROUP BY booking_id HAVING COUNT(*) > 1
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_one_refund_per_booking
          ON payment_transactions (booking_id) WHERE source_type = 'REFUND';
        END IF;
      END $$;
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY,
        action VARCHAR(128) NOT NULL,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        resource_id UUID,
        resource_type VARCHAR(64) NOT NULL,
        original_value JSONB,
        new_value JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs(resource_type, resource_id)
    `)

    // Hot-path composites (added after all the columns above exist):
    //  - slot availability (NOT EXISTS overlap per stylist) and the stylist day/range lists
    //    filter by stylist + start time over active bookings only; the single-column
    //    stylist_id index made Postgres read every historic booking of that stylist.
    //  - payroll and the queue estimator's duration stats scan COMPLETED bookings by completed_at.
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_stylist_active_starts_idx
      ON bookings (stylist_id, starts_at)
      WHERE status IN ('PENDING', 'CONFIRMED', 'STARTED')
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_completed_at_idx
      ON bookings (completed_at)
      WHERE status = 'COMPLETED'
    `)
    // Customer history: e-mail OR phone, newest first, excluding rows the customer removed.
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_customer_visible_starts_idx
      ON bookings (lower(customer_email), starts_at DESC)
      WHERE hidden_from_customer_at IS NULL
    `)
    // Admin search is `ILIKE '%term%'` on customer/service name, which a btree can't serve.
    // Trigram GIN indexes can. pg_trgm ships with Postgres and Neon; if the role may not create
    // extensions the block is skipped instead of failing the boot (the search still works, unindexed).
    await client.query(`
      DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS pg_trgm;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
          CREATE INDEX IF NOT EXISTS bookings_customer_name_trgm_idx ON bookings USING gin (customer_name gin_trgm_ops);
          CREATE INDEX IF NOT EXISTS bookings_service_name_trgm_idx ON bookings USING gin (service_name gin_trgm_ops);
        END IF;
      END $$;
    `)

    // Seeding runs on the same locked client, inside the same transaction. On a
    // separate connection it would deadlock: these writes take a row-share lock
    // on `users` for the foreign keys, while another instance's bootstrap holds
    // `users` exclusively for its `ALTER TABLE` and is waiting for the very
    // tables being written here.
    await ensureStylistProfilesForActiveStaff(client)
  },
})
