import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { CUSTOMER_GENDERS, GENDER_OTHER, GENDER_UNSPECIFIED } from "../lib/gender.js"
import { AUTH_PROVIDER_PASSWORD, AUTH_PROVIDER_UNKNOWN, AUTH_PROVIDERS } from "../lib/auth-provider.js"

const LEGACY_OTHER_GENDER_BACKFILL = "2026-08-15-legacy-other-gender-to-unspecified"
const GRANDFATHER_EXISTING_VERIFICATIONS = "2026-08-15-grandfather-existing-account-verifications"

/**
 * Registry of one-shot data migrations.
 *
 * The `ensure*Schema` DDL is all idempotent, so it can safely run on every boot.
 * A data backfill cannot: this one rewrites OTHER to UNSPECIFIED, and OTHER is
 * also a valid answer a customer can give afterwards. Re-running it would undo
 * that answer and re-prompt them on every visit, forever. Hence a durable marker
 * rather than an `IF NOT EXISTS`-style check.
 */
async function ensureMigrationRegistry(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      id VARCHAR(160) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT
    )
  `)
}

/**
 * One-time correction: legacy customers stored as OTHER become UNSPECIFIED.
 *
 * Until signup started requiring an answer, the gender dropdown was pre-selected
 * to "Other" and could be submitted untouched — so OTHER on an old row does not
 * mean "this customer chose Other", it means "nobody ever asked". Leaving those
 * rows as-is strands them: they get unisex-only reward cards and, because OTHER
 * reads as a stated answer, never see the prompt that would fix it.
 *
 * Rewriting them to UNSPECIFIED discards no real information and puts the
 * question in front of exactly the people it was never asked of. Anyone who
 * genuinely is Other answers once in the popup and is done — and this never runs
 * again, so that answer sticks.
 *
 * Scoped to `role = 'USER'`: gender is only read for customers, so there is no
 * reason to touch staff or admin rows.
 */
async function backfillLegacyOtherGender(client) {
  const { rows: applied } = await client.query(`SELECT 1 FROM applied_migrations WHERE id = $1`, [
    LEGACY_OTHER_GENDER_BACKFILL,
  ])
  if (applied.length) return

  const { rowCount } = await client.query(
    `UPDATE users SET gender = $1, updated_at = NOW() WHERE role = 'USER' AND gender = $2`,
    [GENDER_UNSPECIFIED, GENDER_OTHER]
  )
  await client.query(`INSERT INTO applied_migrations (id, notes) VALUES ($1, $2)`, [
    LEGACY_OTHER_GENDER_BACKFILL,
    `reset ${rowCount} legacy '${GENDER_OTHER}' customer rows to '${GENDER_UNSPECIFIED}'`,
  ])
  console.log(
    `[migration] ${LEGACY_OTHER_GENDER_BACKFILL}: reset ${rowCount} customer row(s) from ${GENDER_OTHER} to ${GENDER_UNSPECIFIED}`
  )
}

/**
 * One-time grandfathering: every account that existed before signup began
 * requiring verification is marked verified.
 *
 * The new columns default to FALSE, which is the correct default for rows
 * created from now on — registration will only ever insert TRUE. But applying
 * that default to the existing table would retroactively mark every current
 * customer unverified, and any check that reads these columns would then lock
 * out people who registered legitimately under the old rules. There is no
 * evidence available to re-derive who did or did not confirm an email years
 * ago, so the honest reading of an old row is "verified under the rules that
 * applied at the time", not "failed a check that did not exist".
 *
 * Marker-guarded rather than idempotent DDL: once this runs, a row set back to
 * FALSE means something real (an email change pending re-confirmation), and a
 * second run would erase that.
 */
async function grandfatherExistingVerifications(client) {
  const { rows: applied } = await client.query(`SELECT 1 FROM applied_migrations WHERE id = $1`, [
    GRANDFATHER_EXISTING_VERIFICATIONS,
  ])
  if (applied.length) return

  const { rowCount } = await client.query(
    `UPDATE users SET email_verified = TRUE, phone_verified = TRUE, updated_at = NOW()`
  )
  await client.query(`INSERT INTO applied_migrations (id, notes) VALUES ($1, $2)`, [
    GRANDFATHER_EXISTING_VERIFICATIONS,
    `grandfathered ${rowCount} pre-existing account(s) as email+phone verified`,
  ])
  console.log(
    `[migration] ${GRANDFATHER_EXISTING_VERIFICATIONS}: marked ${rowCount} pre-existing account(s) verified`
  )
}

/**
 * Customer profile columns: `users.gender` and `users.date_of_birth`.
 *
 * `users.gender` is the column behind gender-aware features (reward-card
 * eligibility, stylist segments).
 *
 * Two things changed here versus the original `ADD COLUMN … DEFAULT 'OTHER'`:
 *
 *  1. The default is now UNSPECIFIED, not OTHER. Any insert path that forgets
 *     to pass a gender records "we never asked" instead of fabricating an
 *     answer the customer never gave.
 *  2. A CHECK constraint pins the column to the four known values, so a typo in
 *     any INSERT fails loudly at the database instead of quietly creating a
 *     fifth gender that every `= 'MALE'` comparison silently misses.
 *
 * A one-time backfill resets legacy OTHER customers to UNSPECIFIED — see
 * `backfillLegacyOtherGender` below for why that is a data correction rather
 * than data loss.
 *
 * `users.date_of_birth` is nullable on purpose — "we don't know your birthday"
 * is a real state, and there is nothing sensible to default it to. Age is
 * derived from it on read (see lib/validation.js) rather than stored, because a
 * stored age is wrong within a year and indistinguishable from a correct one.
 */
export const ensureUserProfileSchema = createSchemaEnsurer({
  name: "auth-user-profile",
  async migrate(client) {
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(16) NOT NULL DEFAULT '${GENDER_UNSPECIFIED}'`
    )
    await client.query(`ALTER TABLE users ALTER COLUMN gender SET DEFAULT '${GENDER_UNSPECIFIED}'`)
    // Older rows may hold lowercase/padded values written before normalization
    // was centralized; the CHECK below would reject them.
    await client.query(`UPDATE users SET gender = upper(btrim(gender)) WHERE gender <> upper(btrim(gender))`)
    await client.query(
      `UPDATE users SET gender = $1 WHERE gender IS NULL OR NOT (gender = ANY($2::text[]))`,
      [GENDER_UNSPECIFIED, CUSTOMER_GENDERS]
    )
    // Added once, not recreated per boot: ADD CONSTRAINT takes ACCESS EXCLUSIVE
    // on `users` and re-validates every row, which is not something to repeat on
    // each instance start. Changing the allowed set is a deliberate migration.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'users_gender_check' AND conrelid = 'users'::regclass
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT users_gender_check
          CHECK (gender IN (${CUSTOMER_GENDERS.map(value => `'${value}'`).join(", ")}));
        END IF;
      END $$;
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS users_gender_idx ON users(gender)`)

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE`)
    // Lower bound only. "Not in the future" cannot live in a CHECK — CURRENT_DATE
    // is not IMMUTABLE and Postgres rejects it there — so that half is enforced by
    // parseDateOfBirth on the way in.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'users_date_of_birth_check' AND conrelid = 'users'::regclass
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT users_date_of_birth_check
          CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01');
        END IF;
      END $$;
    `)
    // Supports "whose birthday is this month" lookups without scanning the table.
    await client.query(`
      CREATE INDEX IF NOT EXISTS users_date_of_birth_month_day_idx
      ON users (EXTRACT(MONTH FROM date_of_birth), EXTRACT(DAY FROM date_of_birth))
      WHERE date_of_birth IS NOT NULL
    `)

    // Proof-of-verification flags, written only from claims on a Firebase ID
    // token (`email_verified`, `phone_number`) — never from anything the client
    // asserts about itself. FALSE is the safe default: a row that somehow skips
    // the registration path is untrusted rather than silently trusted.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`)

    // Which credential the account signs in with. UNKNOWN is the honest default for
    // every row that predates the column and for accounts reception creates on a
    // customer's behalf — see lib/auth-provider.js for why a NULL password_hash on
    // its own could not answer this, and how UNKNOWN rows get classified lazily.
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(16) NOT NULL DEFAULT '${AUTH_PROVIDER_UNKNOWN}'`
    )
    await client.query(`UPDATE users SET auth_provider = upper(btrim(auth_provider)) WHERE auth_provider <> upper(btrim(auth_provider))`)
    await client.query(`UPDATE users SET auth_provider = $1 WHERE auth_provider IS NULL OR NOT (auth_provider = ANY($2::text[]))`, [
      AUTH_PROVIDER_UNKNOWN,
      AUTH_PROVIDERS,
    ])
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'users_auth_provider_check' AND conrelid = 'users'::regclass
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT users_auth_provider_check
          CHECK (auth_provider IN (${AUTH_PROVIDERS.map(value => `'${value}'`).join(", ")}));
        END IF;
      END $$;
    `)
    // An account that already has an app password is a password account by
    // definition; classifying those now keeps the login-path Firebase lookup for
    // the genuinely ambiguous rows only.
    await client.query(`UPDATE users SET auth_provider = $1 WHERE auth_provider = $2 AND password_hash IS NOT NULL`, [
      AUTH_PROVIDER_PASSWORD,
      AUTH_PROVIDER_UNKNOWN,
    ])

    // Last, and inside the same advisory-locked transaction as the DDL above:
    // a second instance booting concurrently blocks on the lock, then sees the
    // committed marker and skips, so the rewrite happens exactly once fleet-wide.
    await ensureMigrationRegistry(client)
    await backfillLegacyOtherGender(client)
    await grandfatherExistingVerifications(client)
  },
})
