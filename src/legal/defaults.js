import { CUSTOMER_CANCELLATION_POLICY_RULES } from "../bookings/cancellation-policy.js"

/**
 * Built-in Privacy Policy and Terms & Conditions, used until the admin saves an edited version.
 * They describe what the application actually does (providers, cookies, retention, refund tiers),
 * so keep them in step with the code when a provider or data practice changes.
 *
 * Body format (rendered by the frontend legal page): "## " starts a numbered section, "### " a
 * sub-heading, "- " a bullet; other lines are paragraphs. Contact details and the refund tiers are
 * filled in from the business profile and the booking rules, so they cannot drift from the app.
 */

/** Effective date of the built-in text. Change it whenever the defaults below change. */
export const DEFAULT_EFFECTIVE_DATE = "2026-10-23"

export const LEGAL_DOCUMENTS = {
  privacy: { title: "Privacy Policy", summary: "How we collect, use, share and protect your personal information." },
  terms: { title: "Terms & Conditions", summary: "The rules for using our website, app and booking services." },
}

function contactFor(profile = {}) {
  const location = [profile.city, profile.state].filter(Boolean).join(", ")
  return {
    name: profile.businessName || "Sahasra Family Salon",
    email: profile.supportEmail || "team@sahasrafamilysalon.in",
    phone: profile.phone || "",
    location: location ? `${location}, India` : "Amalapuram, Andhra Pradesh, India",
  }
}

function contactLines(contact) {
  return [
    `- Email: ${contact.email}`,
    ...(contact.phone ? [`- Phone: ${contact.phone}`] : []),
    "- Website: sahasrafamilysalon.in",
    `- Location: ${contact.location}`,
  ].join("\n")
}

function privacyBody(profile) {
  const c = contactFor(profile)
  return `## Introduction
${c.name} ("we", "us") runs the salon and the website and app at sahasrafamilysalon.in. This policy explains what personal information we collect when you use them, why, who we share it with, how long we keep it and the choices you have.

We process personal information in line with the Digital Personal Data Protection Act, 2023 and other applicable Indian law.

## Information we collect
### Your account
- Name, email address and mobile number.
- Gender, which we use to show services and rewards that suit you, and your date of birth if you choose to add it (for birthday offers).
- Your password, stored only as a one-way hash. If you sign in with Google we receive your name, email address and a Google account identifier instead.
- Whether your email address and mobile number have been verified.
### Bookings and visits
- The services, options, stylist, date and time you book, and the status of each booking (confirmed, started, completed, cancelled or no-show).
- Invoices, booking history and any notes needed to provide the service.
### Payments
- Amounts, payment method (online, cash or UPI at the salon), payment and refund status, and Razorpay order and payment references.
- We never receive or store your full card, UPI PIN or bank login details. Online payments are handled by Razorpay.
### Memberships, offers and rewards
- Your membership plan and its expiry date, referral code, who referred you, wallet balance and reward cards.
### Messages and feedback
- WhatsApp messages we send you and their delivery status, and whether you have opted in to or out of offers.
- Ratings, comments and feedback you give about a visit.
- Questions you type into our support assistant.
### Technical information
- An identifier for your browser or device, your IP address and sign-in events, used to keep accounts secure and to prevent abuse.

## How we use your information
- To create and manage your account and verify your phone number.
- To take, change and cancel bookings, and to tell the salon team what you have booked.
- To take payments, issue invoices and process refunds.
- To send booking messages such as your sign-in code, a welcome message and appointment reminders.
- To run memberships, offers, referrals and rewards.
- To answer your questions and respond to feedback.
- To keep the service secure, prevent fraud and fix problems.
- To meet our legal, tax and accounting obligations.

We send promotional offers on WhatsApp only if you have opted in. You can opt out at any time from your profile, or by replying STOP to any of our WhatsApp messages.

## Who we share information with
We share information only as needed to run the service, and never sell it.
- Salon staff: receptionists and stylists see the bookings they need to handle; the salon's administrators can see bookings, payments and feedback.
- Amazon Web Services: hosts our application and database (see "Where your information is stored").
- Google Firebase: Google sign-in and password-reset emails.
- Meta (WhatsApp Business Platform): delivers our WhatsApp messages, including sign-in codes.
- Razorpay: processes online payments and refunds.
- Cloudinary: stores the photos of our services. It does not receive customer information.
- Anthropic: when the AI support assistant is switched on, the questions you type are sent to Anthropic's API to generate a reply.
- Authorities, courts or others where the law requires it, or to protect the rights and safety of our customers, staff or business.

Each provider handles information under its own terms and only for the service it provides to us.

## AI support assistant
Our support assistant answers questions about services, prices, offers, opening hours and policies. When you are signed in, it can also look up your own bookings and rewards to answer you. It cannot change bookings or payments.

The assistant can make mistakes, so please confirm anything important with the salon. Do not type passwords, payment details or health information into it. We keep a record of each assistant request (for example when it ran and whether it succeeded) for up to 90 days to monitor cost and misuse.

## Where your information is stored
Our application and database run on Amazon Web Services in Sydney, Australia, so your information is stored and processed outside India. Some of the providers listed above may also process information in other countries. We take reasonable steps to keep it protected wherever it is processed, as described in this policy.

## How we protect your information
- Connections to our website and app are encrypted (HTTPS).
- Passwords are stored only as one-way hashes, and sign-in attempts are rate-limited.
- Staff access depends on their role, and staff sessions end when they sign out.
- Payment details stay with Razorpay.

No online service can be completely secure. If a breach affects your personal information, we will notify you and the authorities as the law requires.

## How long we keep information
- Your account information is kept while your account is active and deleted when you ask us to close it, apart from the records below.
- Booking, invoice and payment records are kept for as long as tax and accounting law requires. Removing a booking from your history hides it from your view but keeps the record.
- In-app notifications are deleted 90 days after you read them, and all of them after 365 days.
- WhatsApp sign-in codes expire after a few minutes and are stored only in a form that cannot be read back.

## Your rights
Under applicable law you can ask us to:
- give you a summary of the personal information we hold about you and how we use it;
- correct or complete information that is inaccurate. You can update your name, gender and date of birth in your profile at any time;
- erase your information and close your account, apart from records we must keep by law;
- withdraw consent you gave, such as consent to WhatsApp offers;
- nominate another person to exercise these rights if you die or become unable to.

To make a request or raise a complaint, email ${c.email}. We may need to verify your identity first, and we will reply within a reasonable time. If you are not satisfied with our response, you can complain to the Data Protection Board of India.

## Children
Accounts are meant for adults. Services for children must be booked by a parent or guardian, who provides the child's details and is responsible for the booking.

## Cookies and browser storage
We use only what is needed for the service to work:
- Sign-in cookies that keep you signed in for up to 7 days, or until you sign out. They cannot be read by page scripts.
- Browser storage for your theme, an identifier for your device, the services in an unfinished booking, and progress through sign-up.

We do not use advertising or third-party analytics cookies. Payment pages from Razorpay and sign-in pages from Google may set their own cookies under their own policies.

## Links to other websites
Our website links to other services, such as Google Maps, WhatsApp and Instagram. Their own privacy policies apply when you use them.

## Changes to this policy
We will publish any changes on this page and update the effective date. If a change significantly affects how we use your information, we will tell you in the app or by message before it takes effect.

## Contact us
For questions about this policy or your information, contact ${c.name}:
${contactLines(c)}`
}

function termsBody(profile) {
  const c = contactFor(profile)
  const refunds = CUSTOMER_CANCELLATION_POLICY_RULES.map(rule => `- ${rule.condition}: ${rule.refund}.`).join("\n")
  return `## About these terms
These terms apply when you use the website and app at sahasrafamilysalon.in or book services from ${c.name}. By creating an account or making a booking you agree to them. If you do not agree, please do not use the service.

Nothing in these terms takes away the rights you have as a consumer under Indian law.

## Our services
You can use the website and app to browse our services and prices, book appointments, follow the live queue, manage your bookings and memberships, and collect offers and rewards. The services, prices and features available may change from time to time.

## Your account
- Give accurate details, and keep your name, phone number and email address up to date.
- We confirm your mobile number with a code sent on WhatsApp. Keep your password and codes private, and do not share your account.
- Tell us at once if you think someone else has used your account.
- You are responsible for bookings made from your account.

We may suspend or close an account that is used for fraud or abuse, or that breaks these terms.

## Bookings
- Online bookings can be made for today or tomorrow, at the times shown as available.
- A booking is confirmed only when the app shows it as confirmed. Where online payment is required, a booking is confirmed only after the payment succeeds.
- Please arrive on time. If you are late, your service may be shortened or moved so that other customers are not delayed.
- If you do not arrive and your appointment time passes, the booking is marked as a no-show and is not refunded.
- Occasionally we may need to change the stylist or time, or cancel a booking. We will tell you as soon as we can, and if we cancel, we refund what you paid for that booking in full.

## Cancellations and refunds
You can cancel a booking in the app before it starts. The refund depends on how early you cancel:
${refunds}

Refunds go back to the original payment method through Razorpay. Your bank usually takes 5 to 7 working days to credit them. Payments made in cash or UPI at the salon are refunded by the salon.

## Prices and payment
- Prices are in Indian rupees and are shown before you book. Offers and member prices are applied as shown at checkout.
- The final bill can change if you and your stylist agree to add or change services at the salon.
- Online payments are processed securely by Razorpay. You can also pay at the salon in cash or by UPI where offered.

## Memberships, offers and rewards
- A membership is bought for a fixed period, with its price and benefits shown before you pay. It ends at the end of that period and does not renew automatically.
- Offers, combos and member prices have their own conditions and dates, which are shown with them. Unless stated otherwise, they cannot be exchanged for cash or combined.
- Referral rewards are earned when a person you invite completes their first visit, and may be held for review. We may withhold or remove rewards obtained through fraud or abuse.

## Health and safety
- Tell your stylist about any allergies, skin or scalp conditions, pregnancy or medical treatment before your service. Some services need a patch test first.
- Service descriptions are general guidance, not medical advice. A stylist may decline a service they believe is unsafe for you.
- Please follow the aftercare advice you are given.

## Fair use
You must not:
- try to access other people's accounts or our systems without permission;
- make false or duplicate bookings, or give false information;
- harass staff or other customers, online or at the salon;
- copy, overload or interfere with the website or app;
- use the service for anything unlawful.

## Feedback and reviews
Your feedback must be honest and must not be offensive. We may reply to feedback, and may remove feedback that breaks these terms.

## AI support assistant
Answers from the support assistant are for general information and can be wrong. The prices, times and policies shown in the app and confirmed by the salon apply.

## Third-party services
We use other companies to provide parts of the service, including Razorpay for payments, Google for sign-in and WhatsApp for messages. Their own terms apply when you use them.

## Availability of the service
We work to keep the website and app available, but we cannot promise it will be uninterrupted or error-free. We may pause it for maintenance or updates.

## Intellectual property
The ${c.name} name, logo, photos, text and software belong to us or are used with permission. You may not copy or reuse them without our written permission, except where the law allows.

## Our responsibility to you
We provide our services with reasonable care and skill. As far as the law allows, we are not responsible for losses you could not reasonably have expected, or for losses caused by events outside our reasonable control. Nothing in these terms limits our liability where it cannot be limited by law.

## Privacy
Our Privacy Policy explains how we handle your personal information.

## Changes to these terms
We may update these terms when our services or the law change. The latest version is always on this page with its effective date. If a change affects your existing bookings or memberships, we will tell you before it applies.

## Governing law
These terms are governed by the laws of India.

## Contact us
For questions about these terms, contact ${c.name}:
${contactLines(c)}`
}

const BODIES = { privacy: privacyBody, terms: termsBody }

/** The built-in text of one document, with contact details from the business profile. */
export function defaultLegalBody(slug, profile) {
  return BODIES[slug](profile ?? {})
}
