# WhatsApp setup (Meta Cloud API)

The code is done and tested with a mocked Meta API. **Nothing is sent until you finish the
Meta steps below and set the environment variables.** Adding env vars alone does not put
your number on the Cloud API.

## What it sends (and what it costs)

To keep costs down, only four message types are used. Each one has a monthly cap. When a
cap is reached, that type stops until the next calendar month (Asia/Kolkata).

| Type | Template category | When | Monthly cap (env) | Default |
|---|---|---|---|---|
| Verification code | AUTHENTICATION | Signup phone check. Also phone sign-in and staff setup | `WHATSAPP_MONTHLY_LIMIT_OTP` | 1000 |
| Welcome | UTILITY | Once per new account, after registration succeeds | `WHATSAPP_MONTHLY_LIMIT_WELCOME` | 1000 |
| Appointment reminder | UTILITY | 24 h and 2 h before each confirmed booking | `WHATSAPP_MONTHLY_LIMIT_REMINDER` | 2000 |
| Offer | MARKETING | Only when an admin sends an active offer, and only to customers who opted in | `WHATSAPP_MONTHLY_LIMIT_OFFER` | 1000 |

- **Booking confirmation, cancellation and reschedule messages are off** (`WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES=0`).
  Customers still get these in the app. A cancelled booking's reminders are cancelled. A
  rescheduled booking's reminders move to the new time.
- **Replies to STOP / START cost nothing.** They are free replies inside the customer's own
  24-hour window.
- **Phone-OTP sign-in uses the OTP budget.** Set `WHATSAPP_OTP_LOGIN_ENABLED=false` to keep
  every code for registrations. Customers then sign in with email or Google.
- **Watch the welcome category.** Meta sometimes re-categorises "welcome" templates as
  MARKETING, which costs about 7x more. Keep the text purely informational.
  `npm run whatsapp:check` reports the category Meta assigned.
- **See usage:** `GET /api/admin/whatsapp/status` shows usage this month per type
  (`usageThisMonth`).

## Environment variables (backend only)

Put these in SSM (production) or `bn/.env` (local). Never use `VITE_*` (frontend) variables for them.

| Variable | Required | Purpose / where to get it |
|---|---|---|
| `WHATSAPP_ENABLED` | yes | `true` to send. Anything else means WhatsApp is off. |
| `WHATSAPP_ACCESS_TOKEN` | yes | **System User permanent token**: Business Settings → Users → System users → Generate token. Give it your app, the `whatsapp_business_messaging` and `whatsapp_business_management` permissions, and assign your WABA. Don't use the 24-hour temporary token from API Setup. |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | App dashboard → WhatsApp → API Setup → **Phone number ID** (a long number). It is *not* the phone number. |
| `WHATSAPP_APP_SECRET` | prod | App dashboard → App settings → Basic → App secret. Used to verify webhook signatures. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | prod | A random string of 16+ characters that you make up (for example `openssl rand -hex 24`). Type the same value into Meta's webhook settings. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | optional | WhatsApp Manager → account ID. Only `npm run whatsapp:check` uses it, to verify templates. |
| `WHATSAPP_GRAPH_API_VERSION` | optional | Default `v26.0`. |
| `WHATSAPP_TEMPLATE_OTP` | yes for OTP | Name of your approved AUTHENTICATION template. |
| `WHATSAPP_TEMPLATE_WELCOME` | optional | Approved welcome template name. Empty means welcomes are off. |
| `WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER` | optional | Approved reminder template name. Empty means reminders are off. |
| `WHATSAPP_TEMPLATE_OFFER` | optional | Approved marketing template name. Empty means offers are off. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | optional | Default `en`. Must match the template's language code exactly (`en` vs `en_US`). Override one template with `WHATSAPP_TEMPLATE_<TYPE>_LANGUAGE`. |
| `WHATSAPP_MONTHLY_LIMIT_*` | optional | Caps, see the table above. |
| `WHATSAPP_OTP_LOGIN_ENABLED` | optional | Default `true`. |
| `WHATSAPP_REMINDER_OFFSETS_MINUTES` | optional | Default `1440,120` (24 h and 2 h). |

Placeholder example:

```
WHATSAPP_ENABLED=true
WHATSAPP_ACCESS_TOKEN=your_meta_system_user_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=your_whatsapp_business_account_id
WHATSAPP_APP_SECRET=your_meta_app_secret
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_random_webhook_verification_token
WHATSAPP_GRAPH_API_VERSION=v26.0
WHATSAPP_TEMPLATE_OTP=sahasra_otp
WHATSAPP_TEMPLATE_WELCOME=sahasra_welcome
WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER=sahasra_appointment_reminder
WHATSAPP_TEMPLATE_OFFER=sahasra_offer
```

These template names are suggestions. Use the names you actually create. `bn/.env.example`
lists every optional variable with its default.

**Local development without Meta:** leave `WHATSAPP_ENABLED` unset and set
`WHATSAPP_DEV_FIXED_OTP=123456`. Verification then accepts `123456` and sends nothing. The
server refuses to start in production if this is set.

## Meta setup still required (you)

**Mandatory**
1. **Meta Business portfolio + developer app.** Create an app of type *Business* at
   developers.facebook.com and add the **WhatsApp** product.
2. **Business verification.** In Business Settings → Security Center. Without it you are limited
   to a low number of customers per day, and some template/marketing features are restricted.
3. **Put a phone number on the Cloud API** and get its Phone number ID. See "Your existing
   number" below first.
4. **Payment method.** Add one on the WhatsApp Business Account (WhatsApp Manager → Payment settings).
5. **System User token** with the two permissions above. Keep it in SSM only.
6. **Webhook.** App dashboard → WhatsApp → Configuration:
   - Callback URL: `https://api.sahasrafamilysalon.in/api/whatsapp/webhook`
   - Verify token: the same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field. It carries delivery statuses and STOP/START replies.

   The API must already be deployed with the variables set when you click "Verify".
7. **Create the templates and get them approved** (WhatsApp Manager → Message templates). The
   positional parameters must match exactly:
   - **OTP**: category *Authentication*, "Copy code" button, optional security note and an
     expiry footer of 5 minutes. Meta writes the body itself (`{{1}}` is the code).
   - **Welcome**: category *Utility*. Body example: `Hi {{1}}, your Sahasra Family Salon account is ready. You can book and manage appointments any time on our website.`
   - **Appointment reminder**: category *Utility*. Body example: `Hi {{1}}, a reminder of your {{2}} appointment on {{3}} at {{4}} with {{5}}. Booking ref {{6}}. Need to change it? Call us on {{7}}.`
   - **Offer**: category *Marketing*. Body example: `Hi {{1}}, {{2}} at Sahasra Family Salon, valid until {{3}}. Book on our website.` Add a **"Marketing opt-out" / quick-reply "Stop promotions"** button. Tapping it opts the customer out automatically.
8. Run `npm run whatsapp:check` (from `bn/`, with the values in `.env`). It only reads: it
   confirms the number is on the Cloud API and that every configured template exists, is
   APPROVED in that language, has the right category and has the right number of parameters.

**Your existing number (WhatsApp Business app) — depends on your account**
- The code never registers, migrates or deregisters a number. That is only done in Meta's
  interfaces, by you.
- **Option A, coexistence:** keep using the WhatsApp Business app *and* the API on the same
  number. Meta requires the following:
  - Onboarding goes through **Embedded Signup run by a Meta Tech Provider or Solution Partner**
    (for example a BSP that offers "coexistence"). You scan a QR code from the Business app.
  - Business app version 2.24.17 or later, and a supported country.
  - Open the app at least every ~14 days, or Meta disconnects it (`PRIMARY_INACTIVITY`; the
    server logs this as `whatsapp_account_update`).
  - Throughput is 20 messages/s.
  - Broadcast lists, disappearing and view-once messages stop working in the app.
  - Companion devices are unlinked once (you can relink up to 4; WhatsApp for Windows is not supported).
  - Contact and chat history can be synced only once, within 24 h of onboarding.
  - If you go this route, also subscribe the webhook to `account_update`, `history`,
    `smb_app_state_sync` and `smb_message_echoes`. The server accepts these and ignores
    their content.
- **Option B:** use a separate number for the API (a new SIM or landline that is not on
  WhatsApp). This is the simplest option. Your current number stays as it is in the app.
- **Do not** register your current number directly on Cloud API without coexistence. That
  removes it from the WhatsApp Business app.

## Deployment (AWS, see `DEPLOY_AWS.md`)

1. Store each variable in SSM Parameter Store under `/sahasra/api/<NAME>`. Use SecureString
   for the token, the app secret and the verify token:
   ```
   aws ssm put-parameter --region ap-southeast-2 --name /sahasra/api/WHATSAPP_ACCESS_TOKEN --type SecureString --value '...' --overwrite
   ```
   Repeat for every variable you set. Use `--type String` for the non-secret ones.
2. Redeploy the backend: GitHub → Actions → *Deploy backend to AWS* → Run workflow. You can
   also push to `main`. `deploy.sh` re-reads SSM on every deploy, and env changes need a redeploy.
3. Check the logs: EC2 → Session Manager → `sudo docker logs --tail 100 sahasra-api`. Look for
   `whatsapp_config`. It lists which values are present, never their contents, along with any
   `problems`.
4. **Deploy the frontend only after OTP works.** The frontend now uses WhatsApp for phone
   verification. If it is deployed while WhatsApp is not configured, new signups stop at the
   phone step with "not available right now". Email/Google sign-in is unaffected.
5. Optional, once WhatsApp OTP is live: disable the Phone sign-in provider in Firebase. Nothing
   in the new frontend uses it. The old backend endpoint is kept only for clients that are
   still cached.

## Verification checklist after adding credentials

1. `npm run whatsapp:check` passes.
2. Meta webhook "Verify and save" succeeds.
3. Signup with a new number: a code arrives on WhatsApp; a wrong code shows "isn't right"; the
   right code verifies; finishing the signup creates the account and a welcome message arrives.
4. Press "Send code" twice quickly: only one WhatsApp message arrives.
5. Login tab → Phone OTP with an existing number: code arrives, you are signed in.
6. Staff setup page (`/staff/verify-otp`) with a staff phone number: the code leads to "set password".
7. Book an appointment more than 24 h ahead. Run `SELECT kind, status, scheduled_for FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5;`
   It should show two PENDING reminders, 24 h and 2 h before the appointment. Cancel the
   booking: both become CANCELLED.
8. Customer profile → "Offers on WhatsApp" on. Admin: `GET /api/admin/whatsapp/campaigns-preview?offerType=GLOBAL&offerId=<id>`,
   then `POST /api/admin/whatsapp/campaigns` with `{ "offerType", "offerId", "idempotencyKey" }`.
   The opted-in customer receives the offer. Reply STOP: they are opted out, and get a free confirmation reply.
9. `GET /api/admin/whatsapp/status` shows `usageThisMonth` counting up. In `whatsapp_messages`,
   rows move SENT → DELIVERED → READ as webhooks arrive.

## How it works (for maintenance)

- `src/whatsapp/`: config, Graph client, OTP, outbox and worker, notifications, campaigns,
  webhook, budget.
- Every notification is first a row in `whatsapp_messages`, written in the same database
  transaction as the booking change that caused it. A background worker in the API process
  (every 15 s) sends due rows. It uses `FOR UPDATE SKIP LOCKED` with a lease, so restarts and
  several instances never double-send.
- Before each send the worker reloads the booking or offer. Cancelled, moved or past
  appointments, edited or expired offers, and opted-out customers are skipped.
- Retries back off exponentially (30 s up to 1 h) for up to 5 attempts. Permanent Meta errors
  are not retried.
- Tests: `npm test` in `bn/`. It uses a separate local database, `sahasra_wa_test`, and a
  mocked Meta API.
