# App Analytics Dashboard

> Self-hosted, open-source download analytics for **Apple App Store** and **Google Play** — unified in a single dashboard. Your keys never leave your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## Why?

Apple and Google each have their own analytics dashboards, but:
- You can't see both stores side-by-side
- Historical data is limited (Apple keeps ~1 year in the UI)
- Paid alternatives (AppFigures, Appfollow) cost $30–100+/month
- No existing open-source tool combines both stores

**App Analytics** solves this with a zero-config, zero-cost, self-hosted dashboard.

## Features

- **Unified dashboard** — Apple App Store + Google Play, one screen
- **Web-based setup wizard** — upload API keys through the browser (no `.env` editing)
- **Rich metrics:**
  - Downloads, updates, re-downloads (Apple)
  - Installs, updates, uninstalls (Google)
  - In-app purchases & developer proceeds (Apple)
  - Breakdowns by country, app version, and time period
- **Smart date ranges** — auto-picks yearly/monthly/daily reports for speed
- **All-time history** — fetch data back to 2010
- **Real-time progress** — live progress bar for long fetches
- **Self-hosted** — runs on localhost, data never leaves your machine
- **Zero build step** — plain HTML + Express, no webpack/React/etc.

---

## Quick Start

```bash
git clone https://github.com/chaimPaneth/app-analytics.git
cd app-analytics
npm install
npm start
```

Open **http://localhost:3000** — the setup wizard appears automatically on first launch.

That's it. No database, no Docker, no build step.

---

## Setup Guide

You can configure credentials two ways: the **web UI wizard** (recommended) or **environment variables**.

### Option 1: Web Setup Wizard (Recommended)

On first launch the wizard opens automatically. You can also open it anytime via the **⚙ Settings** button.

The wizard lets you:
1. Paste your Apple/Google credentials into form fields
2. Drag-and-drop (or click to upload) your key files
3. Test each connection before saving
4. Launch the dashboard

All uploaded keys are stored locally in `data/keys/` and **never** transmitted anywhere.

### Option 2: Environment Variables

```bash
cp .env.example .env
# Edit .env with your credentials
npm start
```

---

## Getting Your Credentials

### Apple App Store Connect

<details>
<summary><strong>Step-by-step guide (click to expand)</strong></summary>

#### 1. Create an API Key

1. Go to [App Store Connect → Users and Access → Integrations → Keys](https://appstoreconnect.apple.com/access/integrations/api)
2. Click the **+** button to create a new key
3. Give it a name (e.g., "Analytics Dashboard")
4. For **Access**, select at minimum:
   - **Sales and Trends** — required for download reports
   - **App Manager** or **Admin** — if you also want app listings
5. Click **Generate**
6. **Download the `.p8` file immediately** — Apple only lets you download it once!

#### 2. Note Your IDs

On the same Keys page:
- **Issuer ID** — shown at the top of the page (UUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- **Key ID** — shown next to the key you just created (e.g., `ABC1234DEF`)

#### 3. Find Your Vendor Number

1. Go to [App Store Connect → Sales and Trends](https://appstoreconnect.apple.com/trends)
2. Look at the **top-right dropdown** — your vendor number is the numeric value shown there
3. It's typically an 8-digit number like `87654321`

#### Summary of what you need:

| Credential | Where to find it | Example |
|-----------|-----------------|---------|
| Issuer ID | Keys page, top | `69a6de7e-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Key ID | Next to your key | `ABC1234DEF` |
| .p8 file | Download when creating key | `AuthKey_ABC1234DEF.p8` |
| Vendor Number | Sales and Trends dropdown | `87654321` |

</details>

### Google Play Console

<details>
<summary><strong>Step-by-step guide (click to expand)</strong></summary>

Google Play requires two things: a **service account** for API access and **gsutil** for downloading bulk CSV reports.

#### 1. Create a Service Account

1. Go to [Google Cloud Console → IAM → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Select your project (or create one)
3. Click **+ Create Service Account**
4. Name it (e.g., `play-analytics`)
5. Skip the optional roles step
6. Click **Done**
7. Click on the service account → **Keys** tab → **Add Key** → **Create new key** → **JSON**
8. Download the JSON file

#### 2. Link the Service Account to Play Console

1. Go to [Google Play Console → Settings → API access](https://play.google.com/console/developers/api-access)
2. Find your service account in the list (or click **Link** to add it)
3. Click **Manage permissions** on the service account
4. Under **Account permissions**, enable:
   - ✅ View app information and download bulk reports
   - ✅ View financial data, orders, and cancellation survey responses
5. Click **Invite user** / **Save**

> **Note:** It can take up to 24 hours for permissions to fully propagate.

#### 3. Install gsutil (Google Cloud SDK)

The dashboard uses `gsutil` to download bulk CSV reports from your Play Console's GCS bucket.

**macOS:**
```bash
brew install google-cloud-sdk
```

**Linux:**
```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

**Windows:**
Download from https://cloud.google.com/sdk/docs/install

Then authenticate:
```bash
gcloud init
gcloud auth login
```

Use a Google account that has **Play Console access**.

#### 4. Find Your Developer ID

Your Developer ID is the numeric ID in your Play Console URL:
```
https://play.google.com/console/developers/1234567890123456789/...
                                            ^^^^^^^^^^^^^^^^^^^
                                            This is your Developer ID
```

#### Summary of what you need:

| Credential | Where to find it | Example |
|-----------|-----------------|---------|
| Developer ID | Play Console URL | `12345678901234567890` |
| Service Account JSON | Google Cloud Console → Keys | `my-project-xxxxx.json` |
| gsutil | `brew install google-cloud-sdk` | (CLI tool) |

</details>

---

## Analytics Tracked

### Apple App Store

| Metric | Description |
|--------|-------------|
| **Downloads** | New first-time downloads |
| **Updates** | App version updates |
| **Re-Downloads** | Users re-downloading a previously owned app |
| **In-App Purchases** | IAP transaction count |
| **Proceeds** | Developer revenue in USD |
| **By Country** | Downloads broken down by country code |
| **By Version** | Downloads per app version |

### Google Play

| Metric | Description |
|--------|-------------|
| **Installs** | Daily new device installs |
| **Updates** | Daily device upgrades |
| **Uninstalls** | Daily device uninstalls |
| **By Country** | Installs broken down by country |
| **By Version Code** | Installs per APK/AAB version code |
| **Launch Date** | Earliest data available per app |

---

## Date Range Presets

| Preset | Apple | Google |
|--------|-------|--------|
| **Latest Day** | 2 days ago (Apple's delay) | Auto-detected latest available day |
| **Last 7 Days** | Daily reports | Daily CSV rows |
| **Last 30 Days** | Daily reports | Daily CSV rows |
| **This Month** | Monthly report | Daily CSV rows |
| **Last Month** | Monthly report | Daily CSV rows |
| **All Time** | Smart mix of Yearly + Monthly + Daily | All CSVs since first publish |
| **Custom** | Smart range picker | Date-filtered CSVs |

The "Smart" range automatically picks the fastest combination of yearly, monthly, and daily reports to cover your date range.

---

## How It Compares

| Feature | **App Analytics** | App Store Connect | Play Console | AppFigures | Appfollow |
|---------|:-:|:-:|:-:|:-:|:-:|
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ❌ |
| Free & open source | ✅ | ✅ (limited) | ✅ (limited) | ❌ $30/mo+ | ❌ $83/mo+ |
| Apple + Google unified | ✅ | Apple only | Google only | ✅ | ✅ |
| Web UI key upload | ✅ | N/A | N/A | ✅ | ✅ |
| All-time history | ✅ | ~1 year | ~1 year | ✅ | ✅ |
| No build step | ✅ | N/A | N/A | N/A | N/A |
| Data stays local | ✅ | Cloud | Cloud | Cloud | Cloud |

---

## Project Structure

```
app-analytics/
├── server.js              # Express backend — Apple & Google API integrations
├── public/
│   └── index.html         # Frontend — single HTML file (CSS + JS inlined)
├── data/                   # Created at runtime (gitignored)
│   ├── config.json         # Saved configuration
│   └── keys/               # Uploaded API key files
├── .env.example            # Environment variable template
├── .gitignore
├── package.json
├── LICENSE                 # MIT
└── README.md
```

---

## Troubleshooting

### Apple

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Check your Issuer ID and Key ID are correct |
| `403 Forbidden` | Your API key needs "Sales and Trends" or higher permission |
| `404 Not Found` on reports | Apple reports have a ~2 day delay. Data for today/yesterday isn't available yet |
| `No report data available` | Normal for dates with zero downloads, or for future/very old dates |
| Token errors | Make sure your `.p8` file is the correct one and not corrupted |

### Google Play

| Problem | Solution |
|---------|----------|
| `gsutil: command not found` | Install: `brew install google-cloud-sdk` then `gcloud auth login` |
| `AccessDeniedException: 403` | Your Google account needs Play Console access. Run `gcloud auth login` with the correct account |
| `No URLs matched` | No data exists for that date range — your apps might be too new |
| Empty app list | Service account needs "View app information and download bulk reports" in Play Console |
| Slow downloads | Google Play CSVs are fetched via `gsutil cp`. First fetch may take minutes for all-time data |

### General

| Problem | Solution |
|---------|----------|
| Port 3000 busy | Set a different port: `PORT=3001 npm start` |
| Setup wizard won't appear | Open Settings via ⚙ button, or check `http://localhost:3000/api/status` |
| Config not saving | Check that `data/` directory is writable |

---

## FAQ

<details>
<summary><strong>Is my data sent anywhere?</strong></summary>

No. The server only communicates with Apple's App Store Connect API and Google's Cloud Storage (to download your own reports). No telemetry, no analytics, no third-party services.
</details>

<details>
<summary><strong>Can I deploy this to a server?</strong></summary>

Yes, but be careful — the setup wizard has no authentication. If you deploy publicly, add authentication middleware (e.g., basic auth, OAuth) or restrict access via a VPN/firewall. A simple approach:

```bash
# Basic auth example (add to server.js before routes)
# npm install express-basic-auth
app.use(require('express-basic-auth')({ users: { admin: 'yourpassword' }, challenge: true }));
```
</details>

<details>
<summary><strong>Can I use only Apple or only Google?</strong></summary>

Yes. Configure just one store and the other tab will show an error — but the configured store works fine independently.
</details>

<details>
<summary><strong>How far back does data go?</strong></summary>

- **Apple:** Back to your first app release (2010+), using yearly → monthly → daily reports
- **Google Play:** Back to whenever Google started generating CSV reports for your account (varies per app)
</details>

<details>
<summary><strong>Does this support revenue/financial data?</strong></summary>

Apple: Yes — developer proceeds are tracked from sales reports. Google Play: Not yet — financial reports use a different CSV format. PRs welcome!
</details>

<details>
<summary><strong>Why gsutil and not the Google Cloud Node.js SDK?</strong></summary>

The GCS Node SDK requires a service account with direct bucket access, but Play Console GCS buckets use user-based auth. `gsutil` leverages your `gcloud auth login` session, which is simpler for most users. A future version may support both.
</details>

---

## Contributing

Contributions are welcome! Some ideas:

- **Google Play financial reports** — parse revenue CSVs from GCS
- **Charts/graphs** — add a trend chart (downloads over time)
- **Docker support** — create a Dockerfile for easy deployment
- **Export to CSV/JSON** — allow exporting data from the dashboard
- **Notifications** — alert when downloads spike or drop
- **Authentication middleware** — for public deployments
- **GCS Node SDK option** — alternative to gsutil for Google Play data

```bash
# Development (auto-reloads on changes)
npm run dev

# Check for syntax errors
node -c server.js
```

---

## Security Notes

- API keys are stored **locally** in `data/keys/` and never transmitted externally
- The `data/` directory is gitignored — keys won't be committed
- Server listens on **localhost only** by default
- No analytics, telemetry, or tracking of any kind
- Key file uploads are validated (`.p8` must contain PEM header, service account JSON must have `type: service_account`)
- Input validation on all configuration fields

---

## License

[MIT](LICENSE)
