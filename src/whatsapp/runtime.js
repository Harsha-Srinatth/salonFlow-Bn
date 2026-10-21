/**
 * Boot-time wiring for WhatsApp: config report, schema, the outbox worker and retention.
 * Importing this module also registers every message kind's send-time handler.
 */
import "./notifications.js"
import "./campaigns.js"
import "./webhook.js"
import { describeWhatsAppConfig, isWhatsAppSendingAvailable, validateWhatsAppConfig, whatsappConfig } from "./config.js"
import { prepareWhatsAppNotifications } from "./notifications.js"
import { pruneOtpChallenges } from "./otp.js"
import { pruneWhatsAppTables, startWhatsAppWorker } from "./outbox.js"
import { otpDeliveryMode } from "./otp.js"

/**
 * @returns {Promise<() => Promise<void>>} stop function for graceful shutdown
 */
export async function startWhatsAppRuntime() {
  const config = whatsappConfig()
  const problems = validateWhatsAppConfig(config)
  console.log("whatsapp_config", { ...describeWhatsAppConfig(config), otpDelivery: otpDeliveryMode(config), problems })
  if (!config.enabled) {
    if (otpDeliveryMode(config) === "DEV_FIXED_CODE") await prepareSchemaForDevOtp()
    return async () => {}
  }
  if (!isWhatsAppSendingAvailable(config)) {
    console.error("whatsapp_disabled_by_config_errors", { problems })
    return async () => {}
  }
  await prepareWhatsAppNotifications()
  const stopWorker = startWhatsAppWorker({ intervalMs: config.worker.intervalMs })
  const prune = () =>
    Promise.all([pruneOtpChallenges(), pruneWhatsAppTables()]).catch(error =>
      console.error("whatsapp_prune_failed", { error: error?.message })
    )
  const pruneTimer = setInterval(prune, 6 * 3600_000)
  pruneTimer.unref?.()
  void prune()
  return async () => {
    clearInterval(pruneTimer)
    await stopWorker()
  }
}

async function prepareSchemaForDevOtp() {
  const { ensureWhatsAppSchema } = await import("./schema-init.js")
  await ensureWhatsAppSchema().catch(error => console.error("whatsapp_schema_bootstrap_failed", { error: error?.message }))
}
