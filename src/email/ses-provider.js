/**
 * Sends one message through Amazon SES (API v2). Credentials are never configured here: on the
 * EC2 host the SDK picks up the instance role, whose only send permission is this domain's
 * From address on the two Sahasra configuration sets.
 *
 * Every failure is thrown with `retryable` and `kind`, so the worker can tell "try again later"
 * from "this message can never go out". A retry after a timeout can in rare cases send twice;
 * the alternative is losing the message.
 */
import { GetAccountCommand, SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import { emailConfig } from "./config.js"

const RETRYABLE_NAMES = new Set([
  "TooManyRequestsException",
  "LimitExceededException",
  "Throttling",
  "ThrottlingException",
  "InternalFailure",
  "InternalServerError",
  "ServiceUnavailable",
  "RequestTimeout",
  "TimeoutError",
  "SendingPausedException",
  "CredentialsProviderError",
])

let client = null
let clientRegion = null

function sesClient(config) {
  if (!client || clientRegion !== config.region) {
    client = new SESv2Client({ region: config.region, maxAttempts: 1 })
    clientRegion = config.region
  }
  return client
}

/** Test seam: replaces the SES client. Pass null to restore the real one. */
export function setSesClientForTests(fake) {
  client = fake
  clientRegion = fake ? emailConfig().region : null
}

function failure(error) {
  const name = `${error?.name ?? "Error"}`
  const status = error?.$metadata?.httpStatusCode
  // No HTTP status at all means the request never completed: a network problem.
  const retryable = RETRYABLE_NAMES.has(name) || status === undefined || status >= 500
  return Object.assign(new Error(`${name}: ${`${error?.message ?? "send failed"}`.slice(0, 300)}`), { retryable, kind: name, status })
}

function fromAddress(config) {
  const name = config.fromName.replace(/["\\]/g, "")
  return `"${name}" <${config.fromEmail}>`
}

/**
 * @param {{ to: string, subject: string, html: string, text: string, category: "TRANSACTIONAL" | "MARKETING",
 *   template: string, headers?: Array<{ name: string, value: string }> }} message
 * @returns {Promise<{ messageId: string }>}
 */
export async function sendSesEmail(message, config = emailConfig()) {
  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress(config),
    Destination: { ToAddresses: [message.to] },
    ...(config.replyTo ? { ReplyToAddresses: [config.replyTo] } : {}),
    ConfigurationSetName: message.category === "MARKETING" ? config.marketingConfigurationSet : config.configurationSet,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: message.html, Charset: "UTF-8" },
          Text: { Data: message.text, Charset: "UTF-8" },
        },
        ...(message.headers?.length ? { Headers: message.headers.map(({ name, value }) => ({ Name: name, Value: value })) } : {}),
      },
    },
    EmailTags: [
      { Name: "template", Value: message.template },
      { Name: "category", Value: message.category.toLowerCase() },
    ],
  })
  try {
    const result = await sesClient(config).send(command, { abortSignal: AbortSignal.timeout(config.requestTimeoutMs) })
    return { messageId: result.MessageId }
  } catch (error) {
    throw failure(error)
  }
}

/** The account's sending state for the admin health view. Never throws. */
export async function readSesAccount(config = emailConfig()) {
  try {
    const account = await sesClient(config).send(new GetAccountCommand({}), { abortSignal: AbortSignal.timeout(config.requestTimeoutMs) })
    return {
      available: true,
      productionAccess: account.ProductionAccessEnabled === true,
      sendingEnabled: account.SendingEnabled === true,
      enforcementStatus: account.EnforcementStatus ?? null,
      max24HourSend: account.SendQuota?.Max24HourSend ?? null,
      maxSendRate: account.SendQuota?.MaxSendRate ?? null,
      sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
    }
  } catch (error) {
    return { available: false, error: `${error?.name ?? "Error"}` }
  }
}
