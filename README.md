# Job Scraper — Fall 2026 Internship Hunter

24/7 internship discovery, deduplication, and application-drafting system.
Runs on n8n + SQLite. Never submits without explicit approval.

---

## Project Structure

```
job-scraper/
├── config/
│   ├── target_companies.json     # Company seed list with tiers and careers URLs
│   ├── role_filters.json         # AI/ML, Security, PM keyword rules
│   └── location_policy.json      # Remote + Austin/San Antonio metro rules
├── profile/
│   ├── applicant_profile.schema.json   # JSON schema — shape only
│   └── applicant_profile.example.json  # Fill this in, save as applicant_01.json etc.
├── workflows/
│   ├── 01_discovery_poller.json
│   ├── 02_normalization.json
│   ├── 03_deduplication.json
│   ├── 04_application_drafter.json
│   ├── 05_approval_gate.json
│   ├── 06_alerting.json
│   └── 07_maintenance.json
├── scripts/
│   ├── init_db.sql               # Run once to create the database
│   ├── normalize.js              # Pure normalization logic (no I/O)
│   └── browser_agent.js         # Browser automation stub (implement with Playwright)
├── data/
│   └── jobs.db                  # SQLite database (gitignored)
├── .env.example                 # Copy to .env, fill in values
└── .gitignore
```

---

## Setup (first time)

### 1. Install dependencies

```bash
# n8n (already done if you ran npm install -g n8n)
n8n --version

# Optional: Playwright for browser automation
cd /Users/YOURNAME/Projects/job-scraper
npm init -y
npm install playwright
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with real values — especially:
#   DB_PATH
#   APPLICANT_PROFILE_PATHS
#   ALERT_EMAIL_TO
```

### 3. Create applicant profiles

One JSON file per person. Copy the example and fill in real values:

```bash
cp profile/applicant_profile.example.json profile/applicant_01.json
# Edit applicant_01.json — fill in name, email, education, resume paths, etc.
# Add the path to APPLICANT_PROFILE_PATHS in .env
```

For multiple applicants:
```bash
cp profile/applicant_profile.example.json profile/applicant_02.json
# Edit applicant_02.json, give it a unique profile_id
# Add both paths to APPLICANT_PROFILE_PATHS comma-separated
```

### 4. Initialize the database

```bash
sqlite3 data/jobs.db < scripts/init_db.sql
```

### 5. Start n8n

```bash
n8n start
# Opens at http://localhost:5678
```

### 6. Import workflows

In the n8n UI:
1. Go to **Workflows → Import from file**
2. Import each file in `workflows/` in order (01 through 07)
3. For each workflow, open it and configure the **SQLite credential**:
   - Name: `Jobs DB`
   - Path: your `DB_PATH` from `.env`
4. Configure **SMTP credential** for email alerts
5. Set environment variables in n8n: **Settings → Variables** — add all keys from `.env`
6. Activate workflows 01 and 07 (the pollers)

---

## How It Works

```
Schedule (every 4h)
  → 01 Discovery: fetch careers pages for all active companies
  → 02 Normalization: filter by term, type, role family, location
  → 03 Deduplication: skip already-seen, submitted, or rejected roles
  → 04 Drafting: map form fields from profile, run browser agent
  → Alert: DRAFT_READY (you approve) or NEEDS_USER_INPUT (you answer questions)

You approve via:
  POST http://localhost:5678/webhook/approval
  Body: { "application_id": "...", "action": "approve" }

  → 05 Approval Gate: safety checks, then browser submits
```

---

## Approving Applications

When you receive a `DRAFT_READY` alert, review the draft and send:

```bash
# Approve
curl -X POST http://localhost:5678/webhook/approval \
  -H "Content-Type: application/json" \
  -d '{"application_id": "YOUR_APP_ID", "action": "approve"}'

# Reject
curl -X POST http://localhost:5678/webhook/approval \
  -H "Content-Type: application/json" \
  -d '{"application_id": "YOUR_APP_ID", "action": "reject"}'
```

The system will **never submit without an explicit approve call.**

---

## Responding to NEEDS_USER_INPUT

When a form has a question your profile doesn't cover:

1. Check `novel_questions` in the applications table:
   ```sql
   SELECT novel_questions FROM applications WHERE application_id = 'YOUR_APP_ID';
   ```
2. Add the answer template to `profile/applicant_XX.json` under `short_answer_templates`
3. Re-trigger drafting for that application via n8n manual trigger on workflow 04
4. Once draft is complete, approve normally

---

## Handling needs_attention

These require manual intervention. Common causes:

| Alert Type | What to do |
|---|---|
| `CAPTCHA_BLOCKED` | Visit the careers URL manually, solve once, then re-run discovery for that company |
| `AUTH_EXPIRED` | Re-authenticate on the careers site, update any session tokens in your secrets |
| `SELECTOR_BROKEN` | The site's DOM changed. Update the ATS Parser in workflow 02 for that platform |
| `STALE_ATTENTION` | Check the `jobs` table for that record and update `status` manually after resolving |

---

## Adding Companies

Edit `config/target_companies.json`. Add an entry following the existing schema:

```json
{
  "company_id": "acme_corp",
  "display_name": "Acme Corp",
  "aliases": ["Acme", "Acme Inc"],
  "careers_url": "https://acmecorp.com/careers",
  "aggregator_search_hint": "acme corp internship fall 2026",
  "tier": 4,
  "ats_platform": "greenhouse",
  "active": true,
  "notes": ""
}
```

Set `"active": false` to pause scraping without removing the entry.

**Known ATS platforms** (affects how pages are parsed in workflow 02):
- `greenhouse` — JSON API feed, most reliable
- `lever` — JSON API feed, reliable
- `workday` — JS-rendered, requires browser
- `taleo` — JS-rendered, requires browser
- `google_careers`, `apple_jobs`, `amazon_jobs`, `microsoft_careers` — custom parsers

---

## Database Queries

```sql
-- See all eligible jobs not yet applied to
SELECT company_display, title_normalized, location_normalized, role_family, source_url
FROM jobs WHERE status = 'eligible';

-- See all applications awaiting approval
SELECT a.application_id, j.company_display, j.title_normalized, a.draft_status, a.profile_id
FROM applications a JOIN jobs j ON a.job_key = j.job_key
WHERE a.approval_status = 'pending' AND a.draft_status = 'draft_complete';

-- See submitted applications
SELECT j.company_display, j.title_normalized, a.submitted_at, a.profile_id
FROM applications a JOIN jobs j ON a.job_key = j.job_key
WHERE a.submitted_at IS NOT NULL
ORDER BY a.submitted_at DESC;

-- See what needs attention
SELECT company_display, title_normalized, source_url, filter_reason, updated_at
FROM jobs WHERE status = 'needs_attention';
```

---

## Safe-Stop Conditions

Workflow 07 (runs daily at 2am) will pause all polling and alert you if:
- 3+ companies simultaneously in `needs_attention`
- 5+ crawl failures in the last 24 hours
- Secret store (profile files) unreadable

To resume after a safe-stop: resolve the underlying issue, then manually re-activate workflow 01 in the n8n UI.
