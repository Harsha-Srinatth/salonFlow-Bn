# SMS setup

Customers and staff verify their phone with **Firebase Phone Authentication**. Appointment
reminders go out as **SMS through MSG91**. Nothing else is sent by SMS.

## Firebase phone codes

Firebase sends these codes itself, so they need no DLT registration from you. In the Firebase
console:

1. Authentication → Sign-in method: enable **Phone**.
2. Authentication → Settings → Authorized domains: include `sahasrafamilysalon.in` and the
   Amplify domain.
3. Keep the project on the **Blaze** plan and check the current India price per SMS on
   Firebase's pricing page. Set a budget alert in Google Cloud.

No new environment variables are needed.

## Appointment reminders

Each confirmed booking gets a reminder 24 hours and 2 hours before the appointment. A reminder
is not scheduled if its time has passed or is under 30 minutes away. Cancelling stops them, and
rescheduling moves them. Sending stops for the month at `SMS_MONTHLY_LIMIT_REMINDER` (default 2,000).

### 1. Register on DLT (required by Indian telecom rules)

1. Register the salon as a Principal Entity on a telecom DLT portal (Jio, Airtel, Vi or BSNL).
2. Register a sender ID (6 letters), for example `SAHSRA`.
3. Register this **Service Implicit** content template:
   ```
   Hi {#var#}, reminder: your {#var#} at Sahasra Family Salon is on {#var#} at {#var#}. To change it call {#var#}.
   ```
   Each variable can hold up to 30 characters. The code shortens longer values.

### 2. Set up MSG91

1. Create an account and complete its KYC.
2. Add your DLT entity ID and sender ID.
3. Create an SMS template with the same text and the DLT template ID:
   ```
   Hi ##VAR1##, reminder: your ##VAR2## at Sahasra Family Salon is on ##VAR3## at ##VAR4##. To change it call ##VAR5##.
   ```
4. Copy the **template ID** and your **Authkey**, and add SMS credit.

### 3. Set the variables

| Variable | Required | Purpose |
|---|---|---|
| `SMS_ENABLED` | yes | `true` to send reminders |
| `MSG91_AUTH_KEY` | yes | MSG91 Authkey (keep it secret) |
| `MSG91_REMINDER_TEMPLATE_ID` | yes | MSG91 template ID, not the DLT ID |
| `SMS_REMINDER_OFFSETS_MINUTES` | optional | Default `1440,120` |
| `SMS_REMINDER_MIN_LEAD_MINUTES` | optional | Default `30` |
| `SMS_MONTHLY_LIMIT_REMINDER` | optional | Default `2000`; `0` stops reminders |

In production, store them in SSM under `/sahasra/api/<NAME>` (SecureString for the Authkey), then
deploy the backend as described in `DEPLOY_AWS.md`. With `SMS_ENABLED=true` and a value missing,
the server refuses to start.

### 4. Check it works

1. Make a booking about 3 hours ahead with your own number.
2. Check it was scheduled: `SELECT status, scheduled_for FROM sms_messages ORDER BY created_at DESC LIMIT 5;`
3. Wait for the 2-hour reminder, confirm it arrives, and check the row says `SENT`.
4. Book again and cancel: the rows should become `CANCELLED`.

The MSG91 request format has only been tested against a mock, so this first real send is the
proof. `SENT` means MSG91 accepted the message; delivery is shown in the MSG91 reports.

## Maintenance

The code is in `src/sms/`. Only `client.js` knows the provider, so changing company means
replacing that one file. Tests: `npm test` (separate local database, mocked provider).
