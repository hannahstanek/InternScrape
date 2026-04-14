-- Job Scraper Database Schema
-- Run against SQLite: sqlite3 data/jobs.db < scripts/init_db.sql

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- JOBS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
    job_key             TEXT PRIMARY KEY,  -- SHA-256(company_id + posting_id)
    company_id          TEXT NOT NULL,
    company_display     TEXT NOT NULL,
    title_raw           TEXT NOT NULL,
    title_normalized    TEXT NOT NULL,
    location_raw        TEXT,
    location_normalized TEXT NOT NULL DEFAULT 'unknown',
                        -- values: remote | austin_metro | san_antonio_metro | unknown | rejected
    source              TEXT NOT NULL,
                        -- values: careers_page | linkedin | greenhouse | lever | handshake | indeed | simplify | other
    source_url          TEXT NOT NULL,
    posting_id          TEXT NOT NULL,
    term                TEXT,             -- normalized term label, e.g. "fall_2026"
    role_family         TEXT,             -- ai_ml | security | product_management
    match_tags          TEXT DEFAULT '[]', -- JSON array of matched keywords
    match_score         INTEGER DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'discovered',
                        -- discovered | filtered_out | eligible | draft_ready |
                        -- pending_approval | submitted | rejected_by_user | needs_attention | closed
    filter_reason       TEXT,             -- populated when status = filtered_out
    first_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    closed_at           TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_role_family ON jobs(role_family);
CREATE INDEX IF NOT EXISTS idx_jobs_posting ON jobs(company_id, posting_id);

-- ============================================================
-- APPLICATIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS applications (
    application_id      TEXT PRIMARY KEY, -- UUID v4
    job_key             TEXT NOT NULL REFERENCES jobs(job_key),
    profile_id          TEXT NOT NULL,    -- which applicant profile was used
    draft_status        TEXT NOT NULL DEFAULT 'not_started',
                        -- not_started | in_progress | draft_complete | needs_user_input
    approval_status     TEXT NOT NULL DEFAULT 'pending',
                        -- pending | approved | rejected_by_user
    submitted_at        TEXT,             -- null until actually submitted
    last_error          TEXT,
    form_checkpoint     TEXT DEFAULT '{}', -- JSON blob: browser session save state
    novel_questions     TEXT DEFAULT '[]', -- JSON array of unknown form fields
    resume_variant      TEXT,             -- which resume variant was selected
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_job_key ON applications(job_key);
CREATE INDEX IF NOT EXISTS idx_apps_profile ON applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_apps_draft_status ON applications(draft_status);
CREATE INDEX IF NOT EXISTS idx_apps_approval_status ON applications(approval_status);

-- ============================================================
-- CRAWL LOG TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS crawl_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id          TEXT NOT NULL,
    crawl_started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    crawl_finished_at   TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
                        -- running | success | captcha_blocked | auth_expired | selector_error | failed
    jobs_found          INTEGER DEFAULT 0,
    jobs_new_eligible   INTEGER DEFAULT 0,
    error_detail        TEXT,
    source              TEXT            -- careers_page | aggregator name
);

CREATE INDEX IF NOT EXISTS idx_crawl_company ON crawl_log(company_id);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_log(status);

-- ============================================================
-- ALERTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type          TEXT NOT NULL,
                        -- NEW_ELIGIBLE_JOB | DRAFT_READY | NEEDS_USER_INPUT |
                        -- CAPTCHA_BLOCKED | AUTH_EXPIRED | SELECTOR_BROKEN |
                        -- SUBMISSION_FAILED | STALE_ATTENTION | COMPANY_PENDING
    job_key             TEXT REFERENCES jobs(job_key),
    application_id      TEXT REFERENCES applications(application_id),
    company_id          TEXT,
    detail              TEXT,
    source_url          TEXT,
    sent_at             TEXT,
    acknowledged_at     TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- PENDING COMPANIES TABLE
-- for rule-based expansion: companies seen on aggregators but not yet activated
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_companies (
    company_domain      TEXT PRIMARY KEY,
    display_name        TEXT,
    mention_count       INTEGER DEFAULT 1,
    first_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    activated           INTEGER DEFAULT 0, -- 0 = pending review, 1 = activated by user
    activated_at        TEXT
);

-- ============================================================
-- TRIGGERS: keep updated_at current
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_jobs_updated
    AFTER UPDATE ON jobs
BEGIN
    UPDATE jobs SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE job_key = NEW.job_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_apps_updated
    AFTER UPDATE ON applications
BEGIN
    UPDATE applications SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE application_id = NEW.application_id;
END;
