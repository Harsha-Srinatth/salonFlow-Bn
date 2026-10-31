/**
 * Every email the salon sends: one shared layout, one small function per message.
 *
 * Written for mail clients rather than browsers: table layout, inline styles, a 600 px column
 * that narrows on a phone, a web-safe font stack (Besley and Figtree where the client allows
 * them), and one small image. Each message gets a matching plain-text part. Customer-entered
 * values go through `escapeHtml`; every link is absolute and built from APP_PUBLIC_URL.
 */
import { SALON_TIMEZONE } from "../lib/salon-time.js"

const BRAND = {
  green: "#337154",
  greenDark: "#265e44",
  gold: "#d89b31",
  page: "#f3f6f3",
  card: "#ffffff",
  ink: "#12211a",
  muted: "#526559",
  line: "#dfe7df",
  soft: "#f0f5f1",
}
const SERIF = "Besley, Georgia, 'Times New Roman', Times, serif"
const SANS = "Figtree, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const dateFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" })
const shortDateFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, day: "numeric", month: "short" })
const timeFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true })
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: SALON_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })

export function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function firstName(name) {
  return `${name ?? ""}`.trim().split(/\s+/)[0] || "there"
}

function formatDate(value) {
  return dateFormatter.format(new Date(value))
}

function formatShortDate(value) {
  return shortDateFormatter.format(new Date(value))
}

function formatTime(value) {
  return timeFormatter.format(new Date(value)).toUpperCase()
}

function formatRupees(value) {
  const amount = Number(value ?? 0)
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`
}

function formatDuration(minutes) {
  const total = Number(minutes ?? 0)
  if (!total) return ""
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return [hours ? `${hours} hr` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ")
}

/** "today" / "tomorrow" in salon time, otherwise the date itself. */
function relativeDay(startsAt, now = new Date()) {
  const key = date => dayKeyFormatter.format(date)
  const target = key(new Date(startsAt))
  if (target === key(now)) return "today"
  if (target === key(new Date(now.getTime() + 24 * 3600_000))) return "tomorrow"
  return `on ${formatShortDate(startsAt)}`
}

export function businessAddress(business) {
  return [business.addressLine1, business.addressLine2, business.city, [business.state, business.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ")
}

/** Fallback for the footer if the business profile cannot be read when a message goes out. */
export const DEFAULT_BUSINESS = {
  businessName: "Sahasra Family Salon",
  phone: "",
  supportEmail: "",
  addressLine1: "Red Bridge",
  addressLine2: "",
  city: "Amalapuram",
  state: "Andhra Pradesh",
  postalCode: "",
  mapsUrl: "",
}

function paragraph(html) {
  return `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:24px;color:${BRAND.ink};">${html}</p>`
}

function smallNote(html) {
  return `<p style="margin:0 0 12px;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.muted};">${html}</p>`
}

function button(label, url) {
  const safeUrl = escapeHtml(url)
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
      <tr>
        <td align="center" bgcolor="${BRAND.green}" style="border-radius:10px;background-color:${BRAND.green};">
          <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`
}

function fallbackLink(url) {
  const safeUrl = escapeHtml(url)
  return smallNote(`If the button does not work, copy this link into your browser:<br><a href="${safeUrl}" style="color:${BRAND.greenDark};word-break:break-all;">${safeUrl}</a>`)
}

/** Appointment facts as label/value rows. */
function detailsCard(rows) {
  const cells = rows
    .filter(([, value]) => value)
    .map(
      ([label, value], index) => `
      <tr>
        <td style="padding:${index ? "10px" : "0"} 0 0;font-family:${SANS};font-size:13px;line-height:18px;color:${BRAND.muted};">${escapeHtml(label)}</td>
      </tr>
      <tr>
        <td style="padding:2px 0 0;font-family:${SANS};font-size:16px;line-height:22px;font-weight:600;color:${BRAND.ink};">${escapeHtml(value)}</td>
      </tr>`
    )
    .join("")
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background-color:${BRAND.soft};border-radius:12px;">
      <tr><td style="padding:18px 20px;border-left:3px solid ${BRAND.gold};border-radius:12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table>
      </td></tr>
    </table>`
}

function detailsText(rows) {
  return rows
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n")
}

/**
 * @param {{ appUrl: string, business: object, title: string, preheader: string, body: string,
 *   unsubscribeUrl?: string, footerNote: string }} parts
 */
function layout({ appUrl, business, title, preheader, body, unsubscribeUrl, footerNote }) {
  const address = escapeHtml(businessAddress(business))
  const contact = [business.phone, business.supportEmail].filter(Boolean).map(escapeHtml).join(" &nbsp;·&nbsp; ")
  const site = escapeHtml(appUrl)
  const domain = escapeHtml(appUrl.replace(/^https?:\/\//, ""))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; padding:0; background-color:${BRAND.page}; -webkit-text-size-adjust:100%; }
  a { color:${BRAND.greenDark}; }
  @media only screen and (max-width: 620px) {
    .sh-outer { padding:16px 10px !important; }
    .sh-body { padding:24px 20px !important; }
    .sh-title { font-size:24px !important; line-height:31px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.page};font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background-color:${BRAND.page};">
  <tr>
    <td align="center" class="sh-outer" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td align="center" style="padding:0 0 20px;">
            <a href="${site}" target="_blank" style="text-decoration:none;">
              <img src="${site}/email-logo.png" width="180" height="54" alt="Sahasra Family Salon" style="display:block;border:0;width:180px;height:54px;font-family:${SERIF};font-size:20px;color:${BRAND.greenDark};">
            </a>
          </td>
        </tr>
        <tr>
          <td bgcolor="${BRAND.card}" style="background-color:${BRAND.card};border:1px solid ${BRAND.line};border-radius:16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="sh-body" style="padding:36px 36px 20px;">
                  <h1 class="sh-title" style="margin:0 0 16px;font-family:${SERIF};font-size:27px;line-height:35px;font-weight:600;color:${BRAND.greenDark};">${escapeHtml(title)}</h1>
                  ${body}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:22px 12px 0;font-family:${SANS};font-size:12px;line-height:19px;color:${BRAND.muted};">
            <p style="margin:0 0 6px;font-weight:600;color:${BRAND.ink};">${escapeHtml(business.businessName || "Sahasra Family Salon")}</p>
            <p style="margin:0 0 6px;">${address}</p>
            ${contact ? `<p style="margin:0 0 6px;">${contact}</p>` : ""}
            <p style="margin:0 0 12px;"><a href="${site}" target="_blank" style="color:${BRAND.greenDark};">${domain}</a></p>
            <p style="margin:0;">${escapeHtml(footerNote)}${
              unsubscribeUrl ? ` <a href="${escapeHtml(unsubscribeUrl)}" target="_blank" style="color:${BRAND.greenDark};">Unsubscribe</a>` : ""
            }</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

function textFooter({ appUrl, business, footerNote, unsubscribeUrl }) {
  return [
    "",
    "--",
    business.businessName || "Sahasra Family Salon",
    businessAddress(business),
    [business.phone, business.supportEmail].filter(Boolean).join(" | "),
    appUrl,
    "",
    footerNote,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ]
    .filter(line => line !== null)
    .join("\n")
    .trim()
}

function compose(context, { subject, title, preheader, body, text, footerNote, unsubscribeUrl }) {
  const note = footerNote ?? "This is a service message about your Sahasra account or appointment."
  return {
    subject,
    html: layout({ ...context, title, preheader, body, footerNote: note, unsubscribeUrl }),
    text: `${text.trim()}\n\n${textFooter({ ...context, footerNote: note, unsubscribeUrl })}\n`,
  }
}

function bookingRows(data, { startsAt = data.startsAt } = {}) {
  return [
    ["Date", formatDate(startsAt)],
    ["Time", formatTime(startsAt)],
    ["Services", data.service],
    ["Stylist", data.stylistName],
    ["Duration", formatDuration(data.durationMinutes)],
  ]
}

function bookingsUrl(context) {
  return `${context.appUrl}/user-dashboard/appointments`
}

const TEMPLATES = {
  verify_email(context, { name, verifyUrl, expiresInLabel }) {
    return compose(context, {
      subject: "Confirm your email for Sahasra Family Salon",
      title: "Confirm your email",
      preheader: "One click and your account is ready.",
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(name))},`)}
        ${paragraph("Thanks for creating an account with Sahasra Family Salon. Please confirm this email address to activate it.")}
        ${button("Confirm my email", verifyUrl)}
        ${smallNote(`This link works once and expires in ${escapeHtml(expiresInLabel)}. If you did not sign up, you can ignore this email and no account will be activated.`)}
        ${fallbackLink(verifyUrl)}`,
      text: `Hello ${firstName(name)},

Thanks for creating an account with Sahasra Family Salon. Please confirm this email address to activate it:

${verifyUrl}

This link works once and expires in ${expiresInLabel}. If you did not sign up, you can ignore this email and no account will be activated.`,
    })
  },

  welcome(context, { name }) {
    const bookUrl = `${context.appUrl}/user-dashboard`
    return compose(context, {
      subject: `Welcome to Sahasra Family Salon, ${firstName(name)}`,
      title: `Welcome, ${firstName(name)}`,
      preheader: "Your account is ready. Book your first visit whenever it suits you.",
      body: `
        ${paragraph("Your account is ready. From here you can book a time that suits you, follow your place in the queue on the day, and see your visits and rewards in one place.")}
        ${button("Book an appointment", bookUrl)}
        ${paragraph("If you need help choosing a service, reply to this email or call us and we will be happy to suggest one.")}`,
      text: `Welcome, ${firstName(name)}.

Your account is ready. From here you can book a time that suits you, follow your place in the queue on the day, and see your visits and rewards in one place.

Book an appointment: ${bookUrl}

If you need help choosing a service, reply to this email or call us and we will be happy to suggest one.`,
    })
  },

  account_exists(context, { name }) {
    const loginUrl = `${context.appUrl}/auth/login`
    return compose(context, {
      subject: "Sign-in help for your Sahasra account",
      title: "You already have an account",
      preheader: "Someone tried to register with this email address.",
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(name))},`)}
        ${paragraph("We received a request to create a new account with this email address, but one already exists. You can sign in as usual. If you do not have a password yet or have forgotten it, choose Forgot password on the sign-in page.")}
        ${button("Go to sign in", loginUrl)}
        ${smallNote("If this was not you, no action is needed. Your account has not changed.")}`,
      text: `Hello ${firstName(name)},

We received a request to create a new account with this email address, but one already exists. You can sign in as usual. If you do not have a password yet or have forgotten it, choose Forgot password on the sign-in page.

Sign in: ${loginUrl}

If this was not you, no action is needed. Your account has not changed.`,
    })
  },

  password_reset(context, { name, resetUrl, expiresInLabel }) {
    return compose(context, {
      subject: "Reset your Sahasra Family Salon password",
      title: "Reset your password",
      preheader: `This link expires in ${expiresInLabel}.`,
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(name))},`)}
        ${paragraph("We received a request to reset the password on your account. Choose a new one using the button below.")}
        ${button("Choose a new password", resetUrl)}
        ${smallNote(`This link works once and expires in ${escapeHtml(expiresInLabel)}. If you did not ask for this, you can ignore this email and your password will stay the same.`)}
        ${fallbackLink(resetUrl)}`,
      text: `Hello ${firstName(name)},

We received a request to reset the password on your account. Choose a new one here:

${resetUrl}

This link works once and expires in ${expiresInLabel}. If you did not ask for this, you can ignore this email and your password will stay the same.`,
    })
  },

  booking_confirmation(context, data) {
    const rows = [...bookingRows(data), ["Amount", data.payableAmount > 0 ? formatRupees(data.payableAmount) : ""], ["Invoice", data.invoiceNumber]]
    return compose(context, {
      subject: `Your appointment on ${formatShortDate(data.startsAt)} at ${formatTime(data.startsAt)} is confirmed`,
      title: "Your appointment is confirmed",
      preheader: `${data.service} on ${formatShortDate(data.startsAt)} at ${formatTime(data.startsAt)}.`,
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(data.customerName))}, we look forward to seeing you.`)}
        ${detailsCard(rows)}
        ${button("View my appointment", bookingsUrl(context))}
        ${directions(context)}`,
      text: `Hello ${firstName(data.customerName)}, your appointment is confirmed.

${detailsText(rows)}

View or change it: ${bookingsUrl(context)}${directionsText(context)}`,
    })
  },

  booking_reminder(context, data) {
    const when = relativeDay(data.startsAt, context.now)
    const rows = bookingRows(data)
    return compose(context, {
      subject: `Reminder: your appointment ${when} at ${formatTime(data.startsAt)}`,
      title: `See you ${when}`,
      preheader: `${data.service} at ${formatTime(data.startsAt)}.`,
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(data.customerName))}, this is a reminder of your appointment.`)}
        ${detailsCard(rows)}
        ${button("View my appointment", bookingsUrl(context))}
        ${smallNote("Need to change it? You can cancel from your bookings, or call us and we will help you find a new time.")}
        ${directions(context)}`,
      text: `Hello ${firstName(data.customerName)}, this is a reminder of your appointment ${when}.

${detailsText(rows)}

View it: ${bookingsUrl(context)}
Need to change it? You can cancel from your bookings, or call us and we will help you find a new time.${directionsText(context)}`,
    })
  },

  booking_cancelled(context, data) {
    const rows = [["Date", formatDate(data.startsAt)], ["Time", formatTime(data.startsAt)], ["Services", data.service]]
    const refund =
      Number(data.refundAmount) > 0
        ? `A refund of ${formatRupees(data.refundAmount)} (${Number(data.refundPercent ?? 0)}%) has been recorded. Online payments return to the original payment method.`
        : ""
    const bookUrl = `${context.appUrl}/user-dashboard`
    return compose(context, {
      subject: `Your appointment on ${formatShortDate(data.startsAt)} has been cancelled`,
      title: "Your appointment is cancelled",
      preheader: refund || `${data.service} on ${formatShortDate(data.startsAt)}.`,
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(data.customerName))}, the appointment below has been cancelled.`)}
        ${detailsCard(rows)}
        ${refund ? paragraph(escapeHtml(refund)) : ""}
        ${button("Book a new time", bookUrl)}
        ${smallNote("If you did not expect this, please call us.")}`,
      text: `Hello ${firstName(data.customerName)}, the appointment below has been cancelled.

${detailsText(rows)}
${refund ? `\n${refund}\n` : ""}
Book a new time: ${bookUrl}

If you did not expect this, please call us.`,
    })
  },

  booking_rescheduled(context, data) {
    const rows = [...bookingRows(data), ["Previously", data.previousStartsAt ? `${formatDate(data.previousStartsAt)}, ${formatTime(data.previousStartsAt)}` : ""]]
    return compose(context, {
      subject: `Your appointment has moved to ${formatShortDate(data.startsAt)} at ${formatTime(data.startsAt)}`,
      title: "Your appointment has changed",
      preheader: `New time: ${formatShortDate(data.startsAt)} at ${formatTime(data.startsAt)}.`,
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(data.customerName))}, here are the updated details of your appointment.`)}
        ${detailsCard(rows)}
        ${button("View my appointment", bookingsUrl(context))}
        ${smallNote("If this time does not work for you, please call us and we will find another.")}`,
      text: `Hello ${firstName(data.customerName)}, here are the updated details of your appointment.

${detailsText(rows)}

View it: ${bookingsUrl(context)}

If this time does not work for you, please call us and we will find another.`,
    })
  },

  promotional(context, { name, subject, preheader, headline, body, ctaLabel, ctaUrl, unsubscribeUrl }) {
    const paragraphs = `${body ?? ""}`
      .split(/\n{2,}/)
      .map(part => part.trim())
      .filter(Boolean)
    return compose(context, {
      subject,
      title: headline,
      preheader: preheader || headline,
      unsubscribeUrl,
      footerNote: "You are receiving this because you chose to hear about offers from Sahasra.",
      body: `
        ${paragraph(`Hello ${escapeHtml(firstName(name))},`)}
        ${paragraphs.map(part => paragraph(escapeHtml(part).replace(/\n/g, "<br>"))).join("")}
        ${ctaLabel && ctaUrl ? button(ctaLabel, ctaUrl) : ""}`,
      text: `Hello ${firstName(name)},

${headline}

${paragraphs.join("\n\n")}
${ctaLabel && ctaUrl ? `\n${ctaLabel}: ${ctaUrl}\n` : ""}`,
    })
  },
}

function directions({ business }) {
  const address = businessAddress(business)
  const location = business.mapsUrl
    ? `<a href="${escapeHtml(business.mapsUrl)}" target="_blank" style="color:${BRAND.greenDark};">${escapeHtml(address)}</a>`
    : escapeHtml(address)
  return smallNote(`We are at ${location}.`)
}

function directionsText({ business }) {
  return `\n\nWe are at ${businessAddress(business)}.${business.mapsUrl ? `\nDirections: ${business.mapsUrl}` : ""}`
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES)

/**
 * Renders one message.
 *
 * @param {string} template one of `TEMPLATE_NAMES`
 * @param {object} data the message's own values
 * @param {{ appUrl: string, business?: object, now?: Date }} context
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderEmail(template, data, { appUrl, business = DEFAULT_BUSINESS, now = new Date() }) {
  const render = TEMPLATES[template]
  if (!render) throw new Error(`Unknown email template: ${template}`)
  return render({ appUrl, business, now }, data)
}
