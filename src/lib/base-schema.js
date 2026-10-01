/**
 * Baseline tables the `ensure*Schema` modules build on: `users`, `salons` and the two
 * enums they use.
 *
 * Every other table is created by its own module, but these were only ever described in
 * `drizzle/schema.js` (documentation) and created by hand — so an empty database could
 * not boot: the first `ALTER TABLE users …` failed with `relation "users" does not exist`.
 *
 * Idempotent and cheap on an existing database: one `to_regclass` lookup, no DDL and no
 * locks. Columns added later (gender, date_of_birth, verification flags, auth_provider,
 * membership_segment, loyalty columns, …) are NOT here on purpose; their owning modules
 * add them with `ADD COLUMN IF NOT EXISTS`, which is also what upgrades older databases.
 *
 * @param {import("pg").PoolClient} client Locked schema-bootstrap connection
 */
export async function ensureBaseSchema(client) {
  const { rows } = await client.query("SELECT to_regclass('public.users') AS users, to_regclass('public.salons') AS salons")
  if (rows[0].users && rows[0].salons) return

  await client.query(`
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('USER', 'ADMIN', 'STAFF', 'RECEPTIONIST');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `)
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE account_status AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'PENDING_OTP', 'PHONE_VERIFIED');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      firebase_uid VARCHAR(255),
      role user_role NOT NULL DEFAULT 'USER',
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      image TEXT,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      ban_reason TEXT,
      ban_expires TIMESTAMPTZ,
      device_id VARCHAR(255),
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      referral_code VARCHAR(64),
      referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
      wallet_balance BIGINT NOT NULL DEFAULT 0,
      is_first_booking_done BOOLEAN NOT NULL DEFAULT FALSE,
      is_under_review BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id VARCHAR(255),
      account_status account_status NOT NULL DEFAULT 'ACTIVE',
      password_hash VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_email_unique UNIQUE (email),
      CONSTRAINT users_phone_unique UNIQUE (phone),
      CONSTRAINT users_firebase_uid_unique UNIQUE (firebase_uid),
      CONSTRAINT users_device_id_unique UNIQUE (device_id),
      CONSTRAINT users_referral_code_unique UNIQUE (referral_code),
      CONSTRAINT users_stripe_customer_id_unique UNIQUE (stripe_customer_id)
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)`)
  await client.query(`CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone)`)
  await client.query(`CREATE INDEX IF NOT EXISTS users_role_idx ON users(role)`)
  await client.query(`CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at)`)
  await client.query(`CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users(referred_by)`)
  await client.query(`CREATE INDEX IF NOT EXISTS users_device_id_idx ON users(device_id)`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS salons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      address TEXT NOT NULL,
      pincode VARCHAR(20) NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      phone VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS salons_pincode_idx ON salons(pincode)`)
  await client.query(`CREATE INDEX IF NOT EXISTS salons_owner_id_idx ON salons(owner_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS salons_created_at_idx ON salons(created_at)`)
}
