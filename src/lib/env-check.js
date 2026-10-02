/**
 * Fail fast on a mis-configured production deploy.
 *
 * Without this, a missing STAFF_ACCESS_SECRET silently falls back to a value that is
 * written in the source code: anyone who has read the repo could mint a valid session
 * cookie for any user id. Better to refuse to start than to start insecure.
 * Outside production nothing is enforced, so local development stays zero-config.
 */
const PLACEHOLDERS = new Set(["staff-access-dev-secret", "staff-setup-dev-secret", "changeme", "secret", "sahasra-development-queue-secret"])

export function assertProductionEnv(env = process.env) {
  if (env.NODE_ENV !== "production") return
  const problems = []
  const need = name => {
    const value = `${env[name] ?? ""}`.trim()
    if (!value) problems.push(`${name} is not set`)
    return value
  }
  need("DATABASE_URL")
  need("FRONTEND_ORIGIN")
  for (const name of ["STAFF_ACCESS_SECRET", "STAFF_SETUP_SECRET"]) {
    const value = need(name)
    if (value && (value.length < 32 || PLACEHOLDERS.has(value))) {
      problems.push(`${name} must be a random value of at least 32 characters`)
    }
  }
  if (`${env.RAZORPAY_KEY_ID ?? ""}`.trim()) {
    if (!`${env.RAZORPAY_KEY_SECRET ?? ""}`.trim()) problems.push("RAZORPAY_KEY_SECRET is not set")
    if (!`${env.RAZORPAY_WEBHOOK_SECRET ?? ""}`.trim()) problems.push("RAZORPAY_WEBHOOK_SECRET is not set (webhooks cannot be verified)")
    if (`${env.RAZORPAY_KEY_ID}`.startsWith("rzp_test_")) {
      console.warn("env_check_warning", { message: "RAZORPAY_KEY_ID is a TEST key: no real money will move." })
    }
  }
  if (`${env.STAFF_ACCESS_SECRET ?? ""}` && env.STAFF_ACCESS_SECRET === env.STAFF_SETUP_SECRET) {
    problems.push("STAFF_ACCESS_SECRET and STAFF_SETUP_SECRET must differ")
  }
  if (!`${env.QUEUE_TICKET_SECRET ?? env.JWT_SECRET ?? ""}`.trim()) {
    problems.push("QUEUE_TICKET_SECRET (or JWT_SECRET) is not set")
  }
  if (!`${env.TRUST_PROXY ?? ""}`.trim()) {
    console.warn("env_check_warning", {
      message: "TRUST_PROXY is unset: behind a load balancer every client will share one IP for rate limiting.",
    })
  }
  if (problems.length) {
    console.error("env_check_failed", problems)
    throw new Error(`Refusing to start: ${problems.join("; ")}`)
  }
}
