import { Pool } from "pg"

/**
 * Single shared PostgreSQL pool for the API process.
 * One pool avoids connection churn and keeps configuration in one place for auth and admin routes.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
