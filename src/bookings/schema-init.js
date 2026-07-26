import { pool } from "../lib/db-pool.js"
import { ensureStylistProfilesForActiveStaff, removeLegacyDemoSeedBookings } from "./repository.js"

let bookingsSchemaEnsured = false

export async function ensureBookingsSchema() {
  if (bookingsSchemaEnsured) return
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(16) NOT NULL DEFAULT 'OTHER'`)
  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bookings_starts_at_idx ON bookings(starts_at)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status)
  `)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email_enc TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(32)`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone_enc TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stylist_id UUID REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS bookings_stylist_id_idx ON bookings(stylist_id)`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_items_json JSONB NOT NULL DEFAULT '[]'::jsonb`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payable_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(64)`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS actual_start_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overtime_minutes INTEGER NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'CONFIRMED'`)
  await pool.query(`
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
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS category VARCHAR(64) NOT NULL DEFAULT 'GENERAL'`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS target_gender VARCHAR(16) NOT NULL DEFAULT 'UNISEX'`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 45`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS description TEXT`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS image_url TEXT`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS variants_json JSONB NOT NULL DEFAULT '[]'::jsonb`)
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stylist_service_map (
      id UUID PRIMARY KEY,
      stylist_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(stylist_id, service_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stylist_profiles (
      stylist_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      target_segment VARCHAR(16) NOT NULL DEFAULT 'UNISEX',
      working_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE stylist_profiles ADD COLUMN IF NOT EXISTS working_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE stylist_profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`)
  await pool.query(`
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
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS stylist_leaves_lookup_idx ON stylist_leaves(stylist_id, leave_start, leave_end)`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_payroll_policy (
      id UUID PRIMARY KEY,
      grace_minutes INTEGER NOT NULL DEFAULT 10,
      penalty_per_minute NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS payment_transactions_collected_at_idx ON payment_transactions(collected_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS payment_transactions_mode_idx ON payment_transactions(payment_mode)`)
  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs(resource_type, resource_id)
  `)
  await ensureStylistProfilesForActiveStaff()
  await removeLegacyDemoSeedBookings()
  bookingsSchemaEnsured = true
}
