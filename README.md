# huckleberry-tadpoles-sync

A Cloudflare Worker that copies your child's daycare day from **Tadpoles** into **Huckleberry** every weekday afternoon: diapers, bottles and naps. No more re-entering the daily report by hand, and no more gaps in Huckleberry's sleep predictions on the days you forget.

When it finishes, it sends a push notification to your phone (via [ntfy](https://ntfy.sh)) reporting success or failure. Detailed notifications are an explicit opt-in.

> [!WARNING]
> **Unofficial.** Neither Tadpoles nor Huckleberry offers a public API. This project uses the same private APIs their own apps use, worked out by the community. It is not affiliated with or endorsed by either company, it may break without warning when either app changes, and using it may be against their terms of service. Use it at your own risk, with your own accounts.

## How it works

```
 weekday 5pm (your time zone)
          │
          ▼
 ┌─────────────────┐   1. log in, fetch today's daily report
 │ Cloudflare      │ ─────────────────────────────────────────▶ Tadpoles
 │ Worker (cron)   │
 │                 │   2. translate entries, skip ones already there
 │                 │   3. write new entries                    Huckleberry
 │                 │ ─────────────────────────────────────────▶ (Firebase)
 │                 │
 │                 │   4. summary or failure alert
 └─────────────────┘ ─────────────────────────────────────────▶ ntfy → your phone
```

### What gets synced

| Tadpoles entry | Huckleberry entry |
|---|---|
| Diaper: wet | Diaper: pee |
| Diaper: BM | Diaper: poo |
| Diaper: wet + BM | Diaper: both |
| Diaper: neither | Diaper: dry |
| Diaper cream | Note "Diaper cream" on that diaper |
| Bottle, with amount | Bottle, in **ounces**. Contents: breast milk, formula, or "Other". **Blank contents count as breast milk.** |
| Nap with start and end | Sleep |

**Skipped on purpose:**

- **Entries a parent added at drop-off** (e.g. "last diaper at home", "woke up at 6:10"). They describe time at home, which you've presumably already logged in Huckleberry.
- **Teacher notes and photos.**
- **Anything it doesn't understand yet**, such as solid meals or potty trips. These are listed as "not synced" in the authenticated dry-run response (and detailed notifications if enabled), so you can add them by hand.

### No duplicates

- **Running a day twice is safe.** Each Huckleberry entry gets an ID derived from the Tadpoles entry it came from. On a second run, Huckleberry reports that the entry already exists, and it's skipped.
- **Entries you logged by hand are left alone.** If Huckleberry already has a diaper or bottle within 15 minutes of the daycare's time, or a sleep that overlaps the nap, the daycare entry is skipped and the dry-run response says so.
- **The home screen stays accurate.** Huckleberry's "last diaper / last bottle / last sleep" summary is only updated when the daycare entry is newer than what's there.

## Requirements

- **Tadpoles parent account** that signs in with **email and password**.
  - Google sign-in isn't supported.
- **Huckleberry account** that signs in with **email and password**.
  - If you use Google or Apple sign-in, add a password login in the Huckleberry app first.
  - The account must have **exactly one child**. The sync stops with an error otherwise.
- **Cloudflare account.** The free Workers plan is enough.
- **Node.js 22+** on your computer, to deploy.
- **The ntfy app** on your phone ([iOS](https://apps.apple.com/app/ntfy/id1625396347), [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).

## Setup

### 1. Get the code

```sh
git clone https://github.com/JonahParrish/huckleberry-tadpoles-sync.git
cd huckleberry-tadpoles-sync
npm install
npx wrangler login
```

### 2. Choose your schedule and time zone

The defaults are **5pm US Eastern, Monday–Friday**. Set them in `wrangler.jsonc`:

```jsonc
"vars": {
  "TIMEZONE": "America/New_York", // any IANA time zone name
  "SYNC_HOUR": "17",              // local hour to sync (24h clock)
  ...
}
```

Pick a time after pickup. Daycare reports are usually published at checkout, and a sync that runs earlier only gets part of the day. (Whatever it missed gets added when you rerun that day; see [Running a day by hand](#running-a-day-by-hand).)

**If you change the time zone or hour, also change `triggers.crons`.** Cloudflare's cron schedules run in UTC, so the Worker fires at two UTC hours, one matching standard time and one matching daylight saving time. It skips whichever one isn't `SYNC_HOUR` in your time zone. For example, 5pm Eastern is 22:00 UTC in winter and 21:00 UTC in summer:

```jsonc
"crons": ["0 21 * * 1-5", "0 22 * * 1-5"]
```

| Your zone, 5pm | Crons (UTC) |
|---|---|
| US Eastern | `0 21 * * 1-5`, `0 22 * * 1-5` |
| US Central | `0 22 * * 1-5`, `0 23 * * 1-5` |
| US Mountain | `0 23 * * 1-5`, `0 0 * * 2-6` |
| US Pacific | `0 0 * * 2-6`, `0 1 * * 2-6` |

When 5pm local is after midnight UTC, the UTC day is one later. That's why those rows use `2-6` (Tuesday–Saturday UTC), which is still Monday–Friday where you live. Zones without daylight saving only need one cron.

### 3. Set up notifications

1. **Make a topic name.** On ntfy.sh, anyone who knows the name can read your notifications, so make it long and random:
   ```sh
   echo "daycare-$(openssl rand -hex 12)"
   ```
2. **Subscribe on your phone.** In the ntfy app, tap **+** and subscribe to that exact topic.

To use your own ntfy server, set `NTFY_SERVER` to an HTTPS URL in `wrangler.jsonc`.

For stronger protection, use a topic with **anonymous read and write denied** and set the optional `NTFY_TOKEN` secret to an authorized publishing token. Adding a token alone does not make a public topic private; configure topic access on the server and authenticate the phone subscription too. See [ntfy access control](https://docs.ntfy.sh/config/#access-control). The relay operator can still read message contents. Notifications use the server's normal message cache for background delivery and reconnecting subscribers; ntfy's default cache duration is 12 hours, but server configuration may differ. This is not end-to-end encryption. Keep detailed notifications off if you do not want routine data cached by the relay.

### 4. Add your credentials locally and do a dry run

```sh
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`. It's in `.gitignore`; do not force-add it or paste its contents into issues:

| Name | What it is |
|---|---|
| `TADPOLES_EMAIL`, `TADPOLES_PASSWORD` | Your Tadpoles login |
| `HUCKLEBERRY_EMAIL`, `HUCKLEBERRY_PASSWORD` | Your Huckleberry login |
| `SYNC_TOKEN` | A random password protecting the manual `/sync` URL. Make one with `openssl rand -hex 32`. |
| `NTFY_TOPIC` | The topic from step 3 |
| `NTFY_TOKEN` | Optional publishing token for an access-controlled topic |
| `MANUAL_SYNC_ENABLED` | `true` enables `/sync`; the example enables it locally |
| `NOTIFICATION_DETAILS` | Defaults to `false`; `true` includes event times and feeding/diaper details in push notifications |

Start the Worker locally:

```sh
npm run dev
```

In another terminal, run a dry run for a recent daycare day. A dry run reads from both apps but writes nothing:

```sh
TOKEN=$(grep '^SYNC_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '"')
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8787/sync?date=2026-06-12"
```

You get back JSON listing what would be added, what's already in Huckleberry, and what's skipped. If it looks right, write it for real by using `curl -X POST` and adding `&write=1`. Then check that day in the Huckleberry app.

### 5. Deploy

Store each credential as a Cloudflare secret. Each command prompts for the value:

```sh
npx wrangler secret put TADPOLES_EMAIL
npx wrangler secret put TADPOLES_PASSWORD
npx wrangler secret put HUCKLEBERRY_EMAIL
npx wrangler secret put HUCKLEBERRY_PASSWORD
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put NTFY_TOPIC
# If using an authenticated ntfy topic:
npx wrangler secret put NTFY_TOKEN
```

Then deploy:

```sh
npm run deploy
```

That's it. The sync now runs every weekday at your chosen hour, and your phone gets a notification after each run.

## Updating an existing deployment

From the repository directory, install the dependencies from the updated lockfile, check the changes, and redeploy:

```sh
npm ci
npm test
npm run typecheck
npm run deploy
```

If Wrangler asks you to authenticate, run `npx wrangler login` and retry. Existing Cloudflare secrets remain in place; you do not need to enter the Tadpoles or Huckleberry credentials again. Settings in `.dev.vars` apply to local development, so configure production options in `wrangler.jsonc` and production credentials with `wrangler secret put`.

### Changes when upgrading to the security-hardened version

- **Scheduled sync continues on the configured cron schedule.**
- **Notifications now contain only generic success/failure status by default.** To restore routine details, set `"NOTIFICATION_DETAILS": "true"` in Wrangler `vars`. Configure a private notification topic first (see below).
- **Manual `/sync` access is disabled by default.** If you need it, add `"MANUAL_SYNC_ENABLED": "true"` to Wrangler `vars` before deploying. This option is independent of the cron schedule.
- **Manual authentication requires a Bearer token of at least 32 characters.** If your existing `SYNC_TOKEN` is shorter, generate a replacement with `openssl rand -hex 32`, then store it with `npx wrangler secret put SYNC_TOKEN`. Update your local token and any scripts that use it.
- **Manual writes require POST.** Update existing scripts to use `curl -X POST` with `&write=1`; GET remains a dry run. See [Running a day by hand](#running-a-day-by-hand) for complete commands.
- **Preview URLs are disabled, and scheduled logs no longer contain event data or raw error details.** The main Worker URL remains available, subject to the manual-access setting above.

To switch an existing notification setup to a private topic:

1. Configure the topic on your ntfy server to deny anonymous **reads and writes**, and authenticate the phone subscription. Follow the [ntfy access-control instructions](https://docs.ntfy.sh/config/#access-control).
2. Create an authorized publishing token and store it in Cloudflare:
   ```sh
   npx wrangler secret put NTFY_TOKEN
   ```
3. If the topic changed, update `NTFY_TOPIC` with `npx wrangler secret put NTFY_TOPIC`. If the server changed, update `NTFY_SERVER` in Wrangler `vars` to its HTTPS URL.
4. Run `npm run deploy` after updating configuration, and check notification delivery after the next scheduled run. Manual runs do not send notifications.

Adding `NTFY_TOKEN` alone does not make a public topic private. Leave `NOTIFICATION_DETAILS` unset or `"false"` to keep routine information out of notifications.

After deployment, confirm the next scheduled run in `npx wrangler tail` or the Cloudflare dashboard. If manual access is enabled, you can also run an authenticated dry run to inspect the planned entries. To test the cron handler and notifications before the next normal run, see [Testing the deployed cron job today](#testing-the-deployed-cron-job-today). Earlier logs and notifications are not removed by redeploying; review their retention separately.

## Using it

### Notifications

- **After each run:** a generic completion notice. A completion can mean no report was found; use an authenticated dry run to check details.
- **On failure:** a high-priority generic alert. Raw exceptions, upstream response bodies and account identifiers are excluded.
- **Detailed notifications:** set `NOTIFICATION_DETAILS` to `"true"` in Wrangler vars to include counts, routine details, skipped entries and publication warnings. Use a private topic before opting in.

### Testing notifications without running a sync

A public ntfy.sh topic works with the Worker; self-hosting and `NTFY_TOKEN` are not required. Keep `NTFY_SERVER` as `https://ntfy.sh` and `NTFY_TOPIC` equal to the topic subscribed to in your phone app. Use an authentication token only if you configure topic access controls.

To test the **deployed** notification path immediately, enable `MANUAL_SYNC_ENABLED`, deploy the current code, and use the same terminal `$TOKEN` as for manual sync (see the token prompt below):

```sh
curl -i -X POST -H "Authorization: Bearer $TOKEN" \
  "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/notify-test"
```

This route publishes a fixed generic test message using the deployed Worker's ntfy settings. It does not contact Tadpoles or Huckleberry, write tracker data, accept arbitrary message contents, or depend on the cron hour. It requires the same Bearer authorization and manual-access opt-in as `/sync`.

The diagnostic revision header is `X-Sync-Build: notification-diagnostics-v1`. A successful response contains `"accepted": true` and `"status": 200` (or another successful ntfy HTTP status). This means ntfy returned a matching publication acknowledgment; it **does not** confirm a phone alert was displayed. Check the topic in the app and your phone's notification settings. If it appears in the app but produces no alert, check topic muting, notification permissions, Focus/Do Not Disturb and background delivery. If it is absent entirely, verify the exact server/topic subscription and the deployed `NTFY_TOPIC` secret. Replace that secret with `npx wrangler secret put NTFY_TOPIC` only if it differs from the subscribed topic.

Failures return safe diagnostics such as `Sync failed: ntfy-publish (upstream HTTP 429)`; no topic name, token, message payload or upstream response body is returned. HTTP 401/403 from ntfy means access was rejected; HTTP 429 means the publisher was rate-limited. A request failure means no HTTP response was obtained. A successful status with an invalid acknowledgment is reported as an unexpected API response instead of claiming publication succeeded.

For scheduled runs, distinguish these log messages:

- `Skipping cron ...`: no sync or notification was attempted; a successful Cloudflare invocation alone does not prove the job ran.
- `Scheduled sync completed`: the sync finished, but publishing has not yet completed.
- `Notification accepted by ntfy`: ntfy acknowledged the scheduled notification. If the phone still has no alert, check the subscription/client delivery path.
- `Scheduled sync or notification failed` with `ntfy-publish`: publishing failed after the sync; use the safe status/reason to troubleshoot.

A direct publish followed by a cache poll using local settings can verify the local topic, but does not prove the deployed Worker has the same topic secret. Also allow a short interval before polling a freshly published message; an immediate cache read may not see it yet.

### Running a day by hand

Manual access is **disabled by default**. To enable it in production, add `"MANUAL_SYNC_ENABLED": "true"` to Wrangler `vars` and redeploy. Set `SYNC_TOKEN` to a random value of at least 32 characters (`openssl rand -hex 32` generates 64). Disable manual access again when you no longer need it.

In the terminal where you will run curl, set `TOKEN` to the exact value stored in the deployed Worker's `SYNC_TOKEN` secret. This variable is separate from the Worker secret and is not automatically populated by deploying. The following prompt keeps the value out of terminal output and shell history (bash/zsh):

```sh
printf 'Deployed SYNC_TOKEN: '
read -r -s TOKEN
printf '\n'
printf 'Token length: %s characters\n' "${#TOKEN}"
```

Paste only the token at the prompt, without quotes or the `Bearer ` prefix. The length must be at least 32 characters. A value from `.dev.vars` works against production only if you stored that same value as the production secret. If you no longer know the deployed value, generate a new token with `openssl rand -hex 32`, store it using `npx wrangler secret put SYNC_TOKEN`, and use that same value at the prompt.

Use the deployed Worker's URL (shown by `npm run deploy`). Requests to this `workers.dev` URL execute the deployed Worker in Cloudflare with production secrets; curl runs on your computer only to send the request. Requests to `http://localhost:8787` execute your local development Worker instead:

```sh
# dry run
curl -H "Authorization: Bearer $TOKEN" "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/sync?date=2026-06-12"
# write
curl -X POST -H "Authorization: Bearer $TOKEN" "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/sync?date=2026-06-12&write=1"
```

Use this to backfill a missed day, or to finish a day whose report was published after the scheduled run. It's always safe to repeat; already-synced entries are skipped. Manual runs don't send notifications.

### Testing the deployed cron job today

A successful manual request to the deployed URL verifies the production sync, but it does **not** exercise the `scheduled()` handler, the local-hour guard, or notifications. To test those after the usual 5pm run, temporarily schedule an additional real Cron Trigger. Cloudflare documents local cron-testing tools, but no production “Run now” command; `/__scheduled` is a development route, not a production endpoint.

1. Choose a test time at least **20 minutes in the future**. Cron changes can take [up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
2. Add a temporary expression to `triggers.crons` in `wrangler.jsonc`, keeping the two normal schedules. Cron expressions use **UTC**, including any date/day rollover.
3. Set `vars.SYNC_HOUR` to the test time's **local hour in `TIMEZONE`**. This is required: the handler skips any invocation outside that hour, regardless of the cron expression.
4. Run `npm run deploy`, then watch `npx wrangler tail` or the Worker's **Observability** tab in the Cloudflare dashboard around the scheduled time. Look for `Scheduled sync completed` and confirm the push notification arrives. Also check for a subsequent failure: the completion log precedes notification publishing.
5. **After the test, remove the temporary cron, restore `SYNC_HOUR` to your usual hour (`"17"` by default), and run `npm run deploy` again.** A cron expression repeats until removed; it is not a one-shot job.

For example, **7:30pm US Eastern during daylight saving time (UTC−4)** is 23:30 UTC. If that time is still at least 20 minutes ahead, the temporary configuration would be:

```jsonc
"triggers": {
  "crons": ["0 21 * * 1-5", "0 22 * * 1-5", "30 23 * * *"]
},
"vars": {
  // Keep the other existing vars.
  "TIMEZONE": "America/New_York",
  "SYNC_HOUR": "19"
}
```

Adjust the example for the actual date, time zone and UTC offset; in Eastern standard time, 7:30pm is 00:30 UTC the next day. Keep schedule changes in `wrangler.jsonc` so subsequent deployments use the intended configuration.

This test performs a **real write sync for the local date at the scheduled time** and sends a notification. Entries already synced should be skipped. It does not depend on `MANUAL_SYNC_ENABLED`, so you can disable manual HTTP access after testing without affecting cron runs.

### Logs

```sh
npx wrangler tail
```

Or open the Worker's **Observability** tab in the Cloudflare dashboard.

## Limitations

- **One-way, add-only.** If a teacher edits or deletes an entry after it was synced, Huckleberry isn't updated. Fix it in the app.
- **Solids and potty aren't synced yet.** They're listed in the dry-run response. Pull requests are welcome; a sample of the Tadpoles data for a day with solids is the main thing needed.
- **Free plan limit.** Each run on the free Workers plan can make 50 outside requests. A sync uses about 18 plus 1 per new entry, so up to roughly 30 new entries a day, far more than a typical daycare day.
- **Fragile by nature.** If Tadpoles or Huckleberry change their private APIs, the sync fails and you get an alert. Check for updates here, or open an issue.

## Privacy and security

- **Account scope:** the Worker holds account passwords, which grant broader access than the few fields being synced. Restrict access to Cloudflare, your computer, and deployment credentials. Use unique passwords and account security controls where supported.
- **Credentials:** use Cloudflare Worker secrets in production. Local `.dev.vars*` and `.env*` files are ignored (except example files). Ignore rules do not protect previously committed secrets or forced additions.
- **Data minimization:** teacher notes and photos are not written to Huckleberry. Scheduled runs log completion/failure messages with safe failure stages and HTTP statuses, and failures never include upstream response bodies. Cloudflare invocation metadata may still include manual request dates and URLs. Never put passwords, tokens or topic names in request URLs.
- **Notifications:** routine details are excluded by default. Public ntfy topics allow anyone with the topic name to read messages or forge alerts. Use a private topic with anonymous access denied for stronger protection. HTTPS protects transport; the relay and phone push infrastructure remain trusted parties.
- **Manual access:** disabled unless explicitly enabled, protected by a Bearer token of at least 32 characters, and uncached. GET previews; POST with `write=1` writes. A stolen token permits reading historical sync results and triggering writes. There is no built-in rate limit; disable manual access when unused or protect it with Cloudflare Access/rate limits.
- **Child selection:** Huckleberry must have exactly one child. Multiple matching Tadpoles reports cause the sync to stop rather than silently choosing one. This does not verify that the sole child on each account is the same person; check your first dry run.
- **Firebase app key:** the key in `src/huckleberry.ts` is public client configuration, not an account credential. Data access must be enforced by the provider's authentication and Firestore rules, which this repository cannot audit.
- **Test fixture:** derived from a real Tadpoles report, with names and IDs removed and every date and time shifted to a made-up day. It contains no real routine data.

## Troubleshooting

### 1. Resolve manual authorization errors

A `401 Unauthorized` from `/sync` happens before either app is contacted. Check these separately:

- **Cloudflare secret:** the deployed Worker needs a `SYNC_TOKEN` of at least 32 characters. Set or replace it with `npx wrangler secret put SYNC_TOKEN`, entering the value at the prompt. A local `.dev.vars` value is not uploaded automatically.
- **Terminal variable:** `$TOKEN` must contain that same value in the terminal running curl. Deploying or setting a Cloudflare secret does not populate it. Use the hidden-input prompt in [Running a day by hand](#running-a-day-by-hand); `${#TOKEN}` shows the length without printing the token.
- **Header:** use `Authorization: Bearer $TOKEN`. Enter the token without quotes or the `Bearer ` prefix when prompted. The header itself needs exactly one `Bearer ` prefix.

If you no longer know the deployed token, generate a replacement with `openssl rand -hex 32`, store it with `npx wrangler secret put SYNC_TOKEN`, and use the same value for your terminal variable and any scripts. Retry a dry run. Updating the deployed secret resolved the authorization error during deployment testing; changing the local variable alone cannot update Cloudflare's secret.

A `404 Not found` instead usually means manual access is disabled: enable `"MANUAL_SYNC_ENABLED": "true"` in production Wrangler `vars` and redeploy if you need it. A `405` on `write=1` means the write needs POST.

### 2. Confirm which diagnostic revision is deployed

Use the exact Worker URL printed by the latest `npm run deploy`, and add `-i` to the authenticated **dry-run** request:

```sh
curl -i -H "Authorization: Bearer $TOKEN" \
  "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/sync?date=2026-06-12"
```

This revision returns:

```text
X-Sync-Build: notification-diagnostics-v1
```

Header names may appear lowercase. `login-diagnostics-v3` identifies the older login diagnostic revision; `notification-diagnostics-v1` additionally includes the deployed notification test and acknowledgment logging. These values identify diagnostic revisions, not unique deployment IDs. If it is absent or different, check that you deployed from the updated checkout and are calling the correct Worker's main URL. A successful JSON response with this header confirms that the deployed sync works; review the result before switching to POST with `write=1`.

When reporting a failure, share only the `X-Sync-Build` header and the error text. Do not share successful response data unless scrubbed, and avoid `curl -v`, which prints the Authorization header.

### 3. Diagnose failures after authorization

An authenticated manual failure returns HTTP 502 with a safe stage and, when available, the upstream HTTP status:

```text
Sync failed: tadpoles-login (upstream HTTP 403)
```

That example means the manual token was accepted and the failure occurred while signing in to Tadpoles. It does **not** prove the password is wrong. Responses and scheduled logs omit raw upstream bodies, account identifiers and exception messages.

Older revisions returned only `Sync failed; check account access and configuration`, or a broad `huckleberry-login (unexpected error; possible network failure or unsupported API response)`. Update and redeploy to get the more specific diagnostics below.

**Redirect compatibility fix:** the initial security changes used `redirect: "error"` for Huckleberry login, Firestore requests and ntfy publishing. [Cloudflare Workers rejects that mode](https://developers.cloudflare.com/workers/runtime-apis/request/) before sending any request. The corrected implementation uses `redirect: "manual"` and rejects returned redirects through HTTP status checks. This retains redirect protection without the runtime error. If an old error persists after updating, verify the response header in step 2 before changing credentials.

Huckleberry login now distinguishes these failures:

| Error detail | Meaning / next check |
|---|---|
| `request failed ... before an HTTP response was received` | The request failed before a response was available. A `TypeError` variant identifies the exception type; neither establishes a bad password. Check the deployed revision and retry to distinguish a transient failure. |
| `HTTP response body could not be read` | A response arrived, but reading its body failed. Retry a dry run. |
| `HTTP response body was not valid JSON` | The endpoint returned an unreadable JSON payload. Check for a provider/API change. |
| `unexpected API response` | JSON parsed, but the response was not an account object. |
| `login response did not contain a valid authentication token` | The expected token was absent or malformed. |
| `unsupported account identifier format` | The returned user/child identifier failed validation. |
| `upstream HTTP ...` | The provider returned a non-success status. Investigate access, availability or API changes using the stage below. |

Local Huckleberry login was also checked in Miniflare/workerd during troubleshooting and returned HTTP 200 with a valid token and user ID. That isolated local success did not prove the deployed request worked; the subsequent JSON response with `login-diagnostics-v3`, successful manual write, and scheduled run verified the production paths.

| Failure stage | What to check |
|---|---|
| `configuration` | All four account secrets must exist and be nonblank; `TIMEZONE` must be valid. `npx wrangler secret list` shows secret names, not values. Local `.dev.vars` credentials are not uploaded by deployment. |
| `tadpoles-login` | Tadpoles email/password secrets, supported password login, and provider availability. A redirect or network/API change can also cause failure. |
| `tadpoles-report` | Report API response/access; a child-selection error means multiple matching reports were returned. |
| `mapping` | The report contains an unexpected entry shape. |
| `huckleberry-login` | Use the detailed failure above; check email/password secrets if the evidence points to authentication. |
| `huckleberry-child` | The account must have exactly one child with a supported identifier; check account access if an HTTP status is shown. |
| `huckleberry-read` | Huckleberry/Firestore read permissions or API availability. |
| `huckleberry-write` / `huckleberry-summary` | Entry preparation, write permissions or summary updates. A write run may have partially completed; check the app before retrying. |
| `ntfy-publish` | Notification server/topic configuration, request availability or publish permission/rate limits. Use the deployed `/notify-test` route to test without syncing. |

To replace an account credential, use the relevant command and enter the value at its prompt:

```sh
npx wrangler secret put TADPOLES_EMAIL
npx wrangler secret put TADPOLES_PASSWORD
npx wrangler secret put HUCKLEBERRY_EMAIL
npx wrangler secret put HUCKLEBERRY_PASSWORD
```

Only update the credentials that need correcting. Keep values out of URLs, logs and issues. After updating secrets, retry the authenticated **dry run** without `write=1`.

### 4. Check scheduling and notifications

**Notification delivery fix:** an earlier hardening revision sent `Cache: no`. [ntfy documents](https://docs.ntfy.sh/publish/#message-caching) that this delivers only to connected subscribers and prevents retrieval after reconnection. This can also disrupt iOS background delivery, which retrieves messages after a push wake-up. The Worker now leaves caching enabled under the server's normal policy; generic status messages remain the default. Update and run `npm run deploy`, then test a real scheduled run with the phone app in the background. Previously uncached messages cannot be recovered by this change.

If you kept your existing public topic and did not enable topic access controls, you do not need a new topic or `NTFY_TOKEN` for this fix. Continue using the same `NTFY_SERVER` and `NTFY_TOPIC`. A private topic remains an optional privacy improvement; configure its access rules and authenticate both publishing and the phone subscription together.

| Symptom | What to check |
|---|---|
| No notifications after upgrading, especially with the phone app in the background | Redeploy the notification caching fix described above; also check for publishing failures in Worker logs. |
| Manual sync worked, but no notification | Expected: manual requests do not send notifications. Use [Testing the deployed cron job today](#testing-the-deployed-cron-job-today) to exercise the full cron path. |
| Cloudflare reports success, but no notification arrived | A skipped invocation is also successful. Look for `Notification accepted by ntfy`, or use `/notify-test` to test publication immediately. |
| Cron logs `Skipping cron …` | The scheduled time is outside `SYNC_HOUR` in `TIMEZONE`. One of the two normal DST-covering crons is expected to skip. A temporary test requires changing both the cron and `SYNC_HOUR`. |
| Newly added cron has not fired | Allow up to 15 minutes for propagation; schedule a test at least 20 minutes ahead and verify the UTC conversion. |
| Scheduled sync completed but notification failed | The completion log precedes publishing. Check for a subsequent failure and verify `NTFY_SERVER`, `NTFY_TOPIC`, and optional `NTFY_TOKEN`, topic permissions, and the phone subscription. |
| Failure notification could not be delivered | Check ntfy access/configuration and availability; the original sync may also have failed. |
| Notifications contain only generic status | Expected unless `NOTIFICATION_DETAILS` is explicitly `"true"`. |
| Entries listed as unsupported | That Tadpoles entry type is not supported yet; review it in the app and add it by hand if needed. |

After a temporary scheduled test, remove the extra cron, restore the normal `SYNC_HOUR`, and redeploy. Disabling manual HTTP access afterward does not disable scheduled runs.

## Development

```sh
npm test            # unit tests (vitest), using fake Tadpoles/Huckleberry servers
npm run typecheck   # wrangler types + tsc
npm run dev         # local Worker; /sync works, plus /__scheduled?cron=... to fire the cron
```

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: the cron handler and the `/sync` endpoint |
| `src/sync.ts` | Fetches, compares with existing entries, writes |
| `src/mapping.ts` | Tadpoles entry → Huckleberry entry |
| `src/tadpoles.ts` | Tadpoles client (login, daily report) |
| `src/huckleberry.ts` | Huckleberry client (Firebase Auth + Firestore REST) |
| `src/notify.ts` | ntfy notifications and summary text |
| `src/time.ts` | Time zone helpers |
| `src/errors.ts` | Safe failure stages/reasons and numeric HTTP status diagnostics |
| `test/fixtures/daily-report.json` | A Tadpoles report with names/IDs removed and dates/times shifted to a made-up day |

Changing what gets synced usually means editing `src/mapping.ts` and adding a case to `test/mapping.test.ts`.

## Credits

- [leocov-dev/tadpoles-backup](https://github.com/leocov-dev/tadpoles-backup): Tadpoles login flow.
- [Woyken/py-huckleberry-api](https://github.com/Woyken/py-huckleberry-api): Huckleberry's Firebase document formats.
