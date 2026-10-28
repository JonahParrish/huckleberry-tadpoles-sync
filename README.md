# huckleberry-tadpoles-sync

A Cloudflare Worker that copies your child's daycare day from **Tadpoles** into **Huckleberry** every weekday afternoon: diapers, bottles and naps. No more re-entering the daily report by hand, and no more gaps in Huckleberry's sleep predictions on the days you forget.

When it finishes, it sends a push notification to your phone (via [ntfy](https://ntfy.sh)) summarizing what it added, or telling you what went wrong.

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
- **Anything it doesn't understand yet**, such as solid meals or potty trips. These are listed as "not synced" in the notification, so you can add them by hand.

### No duplicates

- **Running a day twice is safe.** Each Huckleberry entry gets an ID derived from the Tadpoles entry it came from. On a second run, Huckleberry reports that the entry already exists, and it's skipped.
- **Entries you logged by hand are left alone.** If Huckleberry already has a diaper or bottle within 15 minutes of the daycare's time, or a sleep that overlaps the nap, the daycare entry is skipped and the notification says so.
- **The home screen stays accurate.** Huckleberry's "last diaper / last bottle / last sleep" summary is only updated when the daycare entry is newer than what's there.

## Requirements

- **Tadpoles parent account** that signs in with **email and password**.
  - Google sign-in isn't supported.
  - The Bright Horizons version of Tadpoles isn't supported. It uses a different login.
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

To use your own ntfy server, set `NTFY_SERVER` in `wrangler.jsonc`.

### 4. Add your credentials locally and do a dry run

```sh
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`. It's in `.gitignore`, so it never gets committed:

| Name | What it is |
|---|---|
| `TADPOLES_EMAIL`, `TADPOLES_PASSWORD` | Your Tadpoles login |
| `HUCKLEBERRY_EMAIL`, `HUCKLEBERRY_PASSWORD` | Your Huckleberry login |
| `SYNC_TOKEN` | A random password protecting the manual `/sync` URL. Make one with `openssl rand -hex 32`. |
| `NTFY_TOPIC` | The topic from step 3 |

Start the Worker locally:

```sh
npm run dev
```

In another terminal, run a dry run for a recent daycare day. A dry run reads from both apps but writes nothing:

```sh
TOKEN=$(grep '^SYNC_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '"')
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8787/sync?date=2026-06-12"
```

You get back JSON listing what would be added, what's already in Huckleberry, and what's skipped. If it looks right, write it for real by adding `&write=1`. Then check that day in the Huckleberry app.

### 5. Deploy

Store each credential as a Cloudflare secret. Each command prompts for the value:

```sh
npx wrangler secret put TADPOLES_EMAIL
npx wrangler secret put TADPOLES_PASSWORD
npx wrangler secret put HUCKLEBERRY_EMAIL
npx wrangler secret put HUCKLEBERRY_PASSWORD
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put NTFY_TOPIC
```

Then deploy:

```sh
npm run deploy
```

That's it. The sync now runs every weekday at your chosen hour, and your phone gets a notification after each run.

## Using it

### Notifications

- **After each run:** a summary like *"Daycare sync 2026-06-12: 6 diapers, 4 bottles, 3 naps"*. Open it to see each entry it added, anything skipped because you'd already logged it, and anything it couldn't translate.
- **On failure:** a high-priority alert with the error.
- **Report not published yet:** the summary warns that the report may be incomplete.

### Running a day by hand

Use the deployed Worker's URL (shown by `npm run deploy`):

```sh
# dry run
curl -H "Authorization: Bearer $TOKEN" "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/sync?date=2026-06-12"
# write
curl -H "Authorization: Bearer $TOKEN" "https://huckleberry-tadpoles-sync.<your-subdomain>.workers.dev/sync?date=2026-06-12&write=1"
```

Use this to backfill a missed day, or to finish a day whose report was published after the scheduled run. It's always safe to repeat; already-synced entries are skipped. Manual runs don't send notifications.

### Logs

```sh
npx wrangler tail
```

Or open the Worker's **Observability** tab in the Cloudflare dashboard.

## Limitations

- **One-way, add-only.** If a teacher edits or deletes an entry after it was synced, Huckleberry isn't updated. Fix it in the app.
- **Solids and potty aren't synced yet.** They're listed in the notification. Pull requests are welcome; a sample of the Tadpoles data for a day with solids is the main thing needed.
- **Free plan limit.** Each run on the free Workers plan can make 50 outside requests. A sync uses about 18 plus 1 per new entry, so up to roughly 30 new entries a day, far more than a typical daycare day.
- **Fragile by nature.** If Tadpoles or Huckleberry change their private APIs, the sync fails and you get an alert. Check for updates here, or open an issue.

## Privacy and security

- **Credentials** live only in Cloudflare Worker secrets, and in `.dev.vars` on your machine, which is gitignored.
- **Notifications pass through ntfy.sh**, a public relay, unless you run your own server. They contain diaper, feeding and nap times, not names. A failure alert may include a short excerpt of an error response from either service.
- **The `/sync` URL** is protected by `SYNC_TOKEN`. Without the token, it returns 401.
- **`src/huckleberry.ts` contains a Firebase API key.** It's Huckleberry's public app key, built into their app, and it's useless without an account password. GitHub's secret scanning may flag it anyway; it's a false positive.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Unauthorized` from `/sync` | The `Authorization: Bearer` header is missing or doesn't match `SYNC_TOKEN`. In a new terminal, `$TOKEN` may be empty. |
| `Tadpoles POST /auth/login failed` | Wrong Tadpoles email or password, or the account uses Google sign-in. |
| `Huckleberry login failed` | Wrong Huckleberry email or password, or the account has no password login. |
| `Expected exactly one child` | The Huckleberry account has several children (not supported yet). |
| No notification | The phone isn't subscribed to the exact `NTFY_TOPIC`, or it isn't set as a secret. Check `npx wrangler tail`. |
| A scheduled run logs "Skipping cron …" | Expected. One of the two daily crons is always skipped (see [step 2](#2-choose-your-schedule-and-time-zone)). |
| Entries listed as "not synced" | That Tadpoles entry type isn't supported yet. Add it by hand. |

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
| `test/fixtures/daily-report.json` | A real Tadpoles daily report, stripped to the fields the code uses |

Changing what gets synced usually means editing `src/mapping.ts` and adding a case to `test/mapping.test.ts`.

## Credits

- [leocov-dev/tadpoles-backup](https://github.com/leocov-dev/tadpoles-backup): Tadpoles login flow.
- [Woyken/py-huckleberry-api](https://github.com/Woyken/py-huckleberry-api): Huckleberry's Firebase document formats.
