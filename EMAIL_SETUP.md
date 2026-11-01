# Email setup

Customers register and recover their password by email, and get booking confirmations, reminders,
cancellations and rescheduling notices. Promotions go only to customers who opted in. Everything is
sent through **Amazon SES** in `ap-southeast-2`, from `team@sahasrafamilysalon.in`, and replies
come back to that same mailbox.

## How it works

- `src/email/service.js` is the outbox and its worker. Nothing else calls SES. A row in
  `email_messages` is one email, written in the same transaction as the change that caused it. The
  worker runs inside the API process, retries with exponential backoff, and checks each row again
  right before sending.
- Verification and reset tokens are created by the worker at send time, so only their SHA-256 ever
  reaches the database.
- `src/email/events.js` receives SES events through SNS at `POST /api/webhooks/ses`. Hard bounces and
  complaints add the address to `email_suppressions`. A complaint also ends marketing consent.
- A pending signup is marked by `users.pending_email_signup_at`, not by `account_status`. Reception
  also creates accounts as `PENDING_VERIFICATION`, and those are real customers.

## AWS resources

| Resource | Name |
|---|---|
| Domain identity | `sahasrafamilysalon.in` (Easy DKIM, MAIL FROM `bounce.sahasrafamilysalon.in`) |
| Configuration sets | `sahasra-transactional`, `sahasra-marketing` (adds open and click tracking) |
| Events topic | SNS `sahasra-ses-events` |
| Alarms | `sahasra-ses-bounce-rate`, `sahasra-ses-complaint-rate`, to SNS `sahasra-ses-alerts` |
| Send permission | Inline policy `sahasra-ses-send` on role `sahasra-api-ec2`, limited to this identity, these sets and the From address |

No AWS keys are configured anywhere: the container uses the instance role.

## DNS records (Hostinger)

Add these and change nothing else. The root SPF record and the MX records stay as they are:
mail authentication runs through the `bounce` subdomain, so SES never touches Hostinger mail.

| Type | Name | Value | Priority |
|---|---|---|---|
| CNAME | `npi4fdhadrhsaeseu6d53bjfsc7id2lq._domainkey` | `npi4fdhadrhsaeseu6d53bjfsc7id2lq.dkim.amazonses.com` | |
| CNAME | `u6vc6aisuneza66wvh7e55f7ouuegsal._domainkey` | `u6vc6aisuneza66wvh7e55f7ouuegsal.dkim.amazonses.com` | |
| CNAME | `xgh5ppzbawvz63nfxwai6n7thcoh7wdw._domainkey` | `xgh5ppzbawvz63nfxwai6n7thcoh7wdw.dkim.amazonses.com` | |
| MX | `bounce` | `feedback-smtp.ap-southeast-2.amazonses.com` | 10 |
| TXT | `bounce` | `v=spf1 include:amazonses.com ~all` | |

DMARC already exists (`v=DMARC1; p=none`) and needs no change now. Once a few weeks of sending look
clean, tighten it to `p=quarantine` and add `rua=mailto:team@sahasrafamilysalon.in`.

Check the result. `Verified` must be true and DKIM `SUCCESS`, whatever the DNS records look like:

```bash
aws sesv2 get-email-identity --profile sahasra --region ap-southeast-2 --email-identity sahasrafamilysalon.in --query '{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status,MailFrom:MailFromAttributes.MailFromDomainStatus}'
```

## Settings

All in SSM under `/sahasra/api/`, read at each deploy. `.env.example` describes every one.

| Parameter | Value |
|---|---|
| `EMAIL_ENABLED` | Master switch for sending |
| `EMAIL_VERIFICATION_ENABLED` | `/register` and SES password reset |
| `PHONE_VERIFICATION_ENABLED` | Firebase SMS step in registration |
| `EMAIL_REMINDERS_ENABLED` | 24 h and 2 h reminders |
| `EMAIL_MARKETING_ENABLED` | Campaigns can be sent |
| `EMAIL_RECIPIENT_ALLOWLIST` | When set, every other address is skipped |

## Going live

SES accepts nothing until the identity is verified, and until AWS grants production access it only
delivers to verified addresses. So the switches move in this order.

1. **Verified domain, still in the sandbox.** Deploy with `EMAIL_ENABLED=true`, the allowlist set to
   `success@simulator.amazonses.com`, and registration flags unchanged. Subscribe the webhook (below)
   and confirm events arrive.
2. **Production access granted.** Clear `EMAIL_RECIPIENT_ALLOWLIST`, then set
   `EMAIL_VERIFICATION_ENABLED=true` and `PHONE_VERIFICATION_ENABLED=false`, and redeploy. Do this
   before anyone relies on it: with the allowlist still set, real customers would wait for a link
   that is never sent.
3. **Reminders.** Set `EMAIL_REMINDERS_ENABLED=true`.
4. **Promotions.** Set `EMAIL_MARKETING_ENABLED=true` when the salon wants to run a campaign.

To go back to phone verification, set `EMAIL_VERIFICATION_ENABLED=false` and
`PHONE_VERIFICATION_ENABLED=true`, then redeploy. No code or frontend change is needed: the signup
screens read `GET /api/auth/config`.

## Webhook subscription

Once the new API is live, subscribe it. The endpoint confirms the subscription by itself.

```bash
aws sns subscribe --profile sahasra --region ap-southeast-2 --topic-arn arn:aws:sns:ap-southeast-2:961913912951:sahasra-ses-events --protocol https --notification-endpoint https://api.sahasrafamilysalon.in/api/webhooks/ses
```

## Testing without customers

The SES mailbox simulator exercises real sending and real events without a real recipient:
`success@simulator.amazonses.com`, `bounce@simulator.amazonses.com` and
`complaint@simulator.amazonses.com`. Addresses on `.test`, `.example` and similar domains are
skipped by the worker and never reach SES.

## Monitoring

Admin → Email shows sent, delivered, bounced and complained counts, suppressions, and the account's
SES status. AWS reviews an account near 5 % bounces or 0.1 % complaints and can pause it at 10 % or
0.5 %; the alarms fire at the review levels. The first alarm email needs its subscription confirmed
from the `team@` inbox.

Good authentication improves the odds of reaching the inbox. Nothing guarantees it.
