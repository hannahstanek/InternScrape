# InternScrape

InternScrape is a job discovery and application-drafting system for internship searches.
It is built around `n8n`, `SQLite`, and a browser automation sidecar.

The goal is simple:

- collect internship postings on a schedule
- normalize and filter them against your rules
- avoid duplicates
- prepare draft applications
- require explicit approval before anything is submitted

This repository is intentionally sanitized for GitHub.
Personal profiles, real resume paths, live company targeting lists, and local secrets are not included.

## What This Repo Includes

- reusable `n8n` workflows for discovery, normalization, drafting, approval, alerting, and maintenance
- starter config files under `config/`
- a schema and starter template for applicant profiles under `profile/`
- helper scripts for normalization, database setup, and browser automation
- an `.env.example` file showing the required environment variables

## What This Repo Does Not Include

- your real `.env`
- your actual applicant profile JSON files
- your resume files
- your local SQLite database
- your customized company targeting lists and personal filtering rules

Those files stay local by design.

## Project Layout

```text
.
├── config/
│   ├── location_policy.json
│   ├── role_filters.json
│   └── target_companies.json
├── profile/
│   ├── applicant_profile.example.json
│   └── applicant_profile.schema.json
├── scripts/
│   ├── browser_agent.js
│   ├── init_db.sql
│   ├── normalize.js
│   └── setup_credentials.sh
├── workflows/
│   ├── 01_discovery_poller.json
│   ├── 02_normalization.json
│   ├── 03_deduplication.json
│   ├── 04_application_drafter.json
│   ├── 05_approval_gate.json
│   ├── 06_alerting.json
│   └── 07_maintenance.json
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Workflow Overview

The system is designed as a pipeline:

1. `01_discovery_poller` finds internship listings from tracked companies.
2. `02_normalization` standardizes job data and applies role and location filters.
3. `03_deduplication` removes jobs already seen or already handled.
4. `04_application_drafter` prepares draft application data and browser automation inputs.
5. `05_approval_gate` waits for a manual approval or rejection.
6. `06_alerting` sends notifications when action is needed.
7. `07_maintenance` handles cleanup and safe-stop conditions.

The important safety rule is:

**nothing should be submitted without an explicit approval step.**

## Quick Start

### 1. Install prerequisites

You will need:

- Node.js
- `n8n`
- `sqlite3`
- Playwright if you plan to use browser automation

Example setup:

```bash
npm install
npx playwright install chromium
```

If `n8n` is not installed yet:

```bash
npm install -g n8n
```

### 2. Create your local environment file

```bash
cp .env.example .env
```

Then edit `.env` with your local values.

At minimum, review:

- `DB_PATH`
- `APPLICANT_PROFILE_PATHS`
- `TARGET_COMPANIES_PATH`
- `ROLE_FILTERS_PATH`
- `LOCATION_POLICY_PATH`
- alerting variables such as email, Slack, or SMS settings

### 3. Create your local applicant profile

This repo includes a starter template, not your real profile.

```bash
cp profile/applicant_profile.example.json profile/applicant_01.json
```

Fill in your local copy with:

- name and contact info
- education details
- work authorization
- resume file paths
- reusable short-answer templates
- common application answers

Do not commit that filled-in file.

### 4. Customize the sanitized config files

The files in `config/` are starter placeholders in this public repo.
Before running real searches, update them locally:

- `config/target_companies.json`
  Add the companies you want to track.
- `config/role_filters.json`
  Add your internship terms, role families, and exclusion rules.
- `config/location_policy.json`
  Add the location labels and matching logic you want to use.

### 5. Initialize the database

```bash
sqlite3 data/jobs.db < scripts/init_db.sql
```

### 6. Start n8n

```bash
n8n start
```

By default, the UI is available at `http://localhost:5678`.

### 7. Import the workflows

In the `n8n` UI:

1. Import each JSON file from `workflows/`
2. Configure the SQLite credential to point at your `DB_PATH`
3. Configure your alerting credentials
4. Add the required environment variables in `n8n`
5. Activate the workflows you want to run

## Approval Flow

The repository is built around manual approval before submission.

Example approval request:

```bash
curl -X POST http://localhost:5678/webhook/approval \
  -H "Content-Type: application/json" \
  -d '{"application_id":"YOUR_APP_ID","action":"approve"}'
```

Example rejection:

```bash
curl -X POST http://localhost:5678/webhook/approval \
  -H "Content-Type: application/json" \
  -d '{"application_id":"YOUR_APP_ID","action":"reject"}'
```

## Configuration Notes

### Applicant profile files

The schema lives at `profile/applicant_profile.schema.json`.
The example file is intentionally blanked out so it is safe to publish.

### Config files

The three files in `config/` are also intentionally minimal in this repo.
They are meant to be copied and customized locally, not used as production-ready defaults.

### Secrets and local data

These are ignored by Git:

- `.env`
- `data/`
- `node_modules/`
- `package-lock.json`
- real applicant profile JSON files under `profile/`

## Scripts

- `scripts/init_db.sql`
  Creates the SQLite schema.
- `scripts/normalize.js`
  Contains normalization logic used by the workflow pipeline.
- `scripts/browser_agent.js`
  Stub for browser-driven application automation.
- `scripts/setup_credentials.sh`
  Helper for local credential setup.

## Current Limitations

- `package.json` does not yet define a real automated test suite.
- The browser automation sidecar is still a starting point, not a finished production agent.
- The public config files are intentionally empty starter versions, so this repo needs local setup before it does useful work.

## Suggested Next Improvements

- add a real `npm test` command
- document the expected SQLite schema with examples
- add sample `n8n` screenshots or import instructions
- add a local development script for first-time setup
- add validation checks for config and profile JSON files

## License

No license is currently defined in `package.json`.
If you plan to share or reuse this project publicly, add one explicitly.
