#!/usr/bin/env node
/**
 * browser_agent.js
 *
 * Playwright-based browser automation for job form filling and submission.
 * Called by n8n Execute Command nodes:
 *
 *   node browser_agent.js fill <application_id> <source_url> <resume_path>
 *   node browser_agent.js submit <application_id> <source_url> <checkpoint_json_b64>
 *
 * Outputs one JSON line to stdout. n8n reads via $json.stdout.
 *
 * Hard rules enforced here:
 *   - Never click submit/apply without being in 'submit' mode
 *   - Never guess on novel form fields
 *   - Never solve CAPTCHAs
 *   - Stop and output error on any login wall
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [,, command, applicationId, sourceUrl, thirdArg] = process.argv;
const TIMEOUT = parseInt(process.env.BROWSER_TIMEOUT_MS || '30000', 10);
const HEADLESS = process.env.BROWSER_HEADLESS !== 'false';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

function loadFillPlan(appId) {
  const planPath = `/tmp/fill_plan_${appId}.json`;
  if (!fs.existsSync(planPath)) return {};
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    fs.unlinkSync(planPath);
    return plan;
  } catch {
    return {};
  }
}

// ---- Field label fuzzy matcher ----
// Returns the best-matching fill_plan key for a given form label, or null.
function matchLabel(label, fillPlan) {
  if (!label) return null;
  const norm = label.toLowerCase().replace(/[*:]/g, '').trim();

  // Exact match first
  if (fillPlan[norm] !== undefined) return norm;

  // Substring match (plan key appears in label or label appears in key)
  for (const key of Object.keys(fillPlan)) {
    if (norm.includes(key) || key.includes(norm)) return key;
  }

  return null;
}

// ---- Detect hostile page states ----
async function detectHostilePage(page) {
  const url = page.url();
  const title = (await page.title()).toLowerCase();
  const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');

  if (bodyText.includes('captcha') || bodyText.includes('are you a robot') ||
      bodyText.includes('verify you are human') || title.includes('captcha')) {
    return 'captcha';
  }
  if (bodyText.includes('sign in') || bodyText.includes('log in') ||
      bodyText.includes('create an account') || url.includes('/login') || url.includes('/signin')) {
    return 'auth_required';
  }
  return null;
}

// ---- Extract form fields from current page ----
async function extractFormFields(page) {
  return page.evaluate(() => {
    const fields = [];
    const inputs = document.querySelectorAll('input, textarea, select');

    for (const el of inputs) {
      const type = el.tagName.toLowerCase() === 'select' ? 'select'
        : el.tagName.toLowerCase() === 'textarea' ? 'textarea'
        : (el.getAttribute('type') || 'text').toLowerCase();

      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;

      // Find associated label
      let label = '';
      const id = el.id;
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) label = labelEl.innerText;
      }
      if (!label) {
        const parent = el.closest('label, [class*="field"], [class*="form-group"], [class*="input-wrapper"]');
        if (parent) {
          const labelEl = parent.querySelector('label, [class*="label"]');
          if (labelEl) label = labelEl.innerText;
        }
      }
      if (!label && el.placeholder) label = el.placeholder;
      if (!label && el.name) label = el.name.replace(/[_-]/g, ' ');
      if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');

      const required = el.required || el.getAttribute('aria-required') === 'true';

      fields.push({
        label: label.trim(),
        type,
        name: el.name || el.id || '',
        selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null,
        required,
        options: type === 'select'
          ? Array.from(el.options).map(o => o.text).filter(t => t.trim())
          : []
      });
    }
    return fields;
  });
}

// ---- Fill a single field ----
async function fillField(page, field, value) {
  if (!field.selector || value === null || value === undefined || value === '') return;

  try {
    if (field.type === 'select') {
      await page.selectOption(field.selector, { label: value }, { timeout: 5000 }).catch(async () => {
        // fallback: try value match
        await page.selectOption(field.selector, value, { timeout: 3000 });
      });
    } else if (field.type === 'checkbox') {
      const checked = ['yes', 'true', '1'].includes(String(value).toLowerCase());
      if (checked) await page.check(field.selector, { timeout: 5000 });
    } else if (field.type === 'file') {
      if (fs.existsSync(value)) {
        await page.setInputFiles(field.selector, value, { timeout: 10000 });
      }
    } else {
      await page.fill(field.selector, String(value), { timeout: 5000 });
    }
  } catch {
    // Field not interactable — skip, don't error
  }
}

// ---- FILL subcommand ----
async function fill(applicationId, sourceUrl, resumePath) {
  const { chromium } = require('playwright');
  const fillPlan = loadFillPlan(applicationId);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(sourceUrl, { waitUntil: 'networkidle', timeout: TIMEOUT });

    const hostile = await detectHostilePage(page);
    if (hostile === 'captcha') {
      await browser.close();
      out({ status: 'error', checkpoint: {}, novel_questions: [], error: 'captcha_detected' });
    }
    if (hostile === 'auth_required') {
      await browser.close();
      out({ status: 'error', checkpoint: {}, novel_questions: [], error: 'auth_required' });
    }

    const fields = await extractFormFields(page);
    const novelQuestions = [];

    for (const field of fields) {
      // File upload: try to match to resume
      if (field.type === 'file') {
        if (resumePath && fs.existsSync(resumePath)) {
          await fillField(page, field, resumePath);
        }
        continue;
      }

      const matchedKey = matchLabel(field.label, fillPlan);

      if (matchedKey !== null) {
        await fillField(page, field, fillPlan[matchedKey]);
      } else if (field.required) {
        // Required field with no mapping — flag as novel, DO NOT GUESS
        novelQuestions.push({
          label: field.label,
          type: field.type,
          name: field.name,
          options: field.options,
          note: 'Add answer to short_answer_templates or common_answers in your profile'
        });
      }
      // Optional unmapped fields: skip silently
    }

    const checkpoint = {
      url: page.url(),
      saved_at: new Date().toISOString(),
      application_id: applicationId,
      fields_filled: fields.length - novelQuestions.length,
      fields_total: fields.length
    };

    await browser.close();

    if (novelQuestions.length > 0) {
      out({ status: 'needs_user_input', checkpoint, novel_questions: novelQuestions, error: null });
    } else {
      out({ status: 'draft_complete', checkpoint, novel_questions: [], error: null });
    }

  } catch (err) {
    await browser.close().catch(() => {});
    const msg = err.message || '';
    if (msg.toLowerCase().includes('timeout')) {
      out({ status: 'error', checkpoint: {}, novel_questions: [], error: 'page_timeout' });
    }
    out({ status: 'error', checkpoint: {}, novel_questions: [], error: msg });
  }
}

// ---- SUBMIT subcommand ----
async function submit(applicationId, sourceUrl, checkpointB64) {
  const { chromium } = require('playwright');

  let checkpoint = {};
  try {
    checkpoint = JSON.parse(
      checkpointB64 ? Buffer.from(checkpointB64, 'base64').toString('utf8') : '{}'
    );
  } catch {
    checkpoint = {};
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Restore to checkpoint URL (or source URL as fallback)
    const targetUrl = checkpoint.url || sourceUrl;
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: TIMEOUT });

    const hostile = await detectHostilePage(page);
    if (hostile) {
      await browser.close();
      out({ status: 'error', error: `hostile_page: ${hostile}` });
    }

    // Verify we're on the expected page
    const currentUrl = page.url();
    if (checkpoint.url && !currentUrl.includes(new URL(checkpoint.url).hostname)) {
      await browser.close();
      out({ status: 'error', error: 'checkpoint_mismatch: page URL does not match saved checkpoint' });
    }

    // Find and click the submit/apply button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit Application")',
      'button:has-text("Apply Now")',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      '[data-testid="submit-btn"]',
      '[class*="submit"]'
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click({ timeout: 10000 });
        // Wait for navigation or success signal
        await page.waitForNavigation({ timeout: 15000, waitUntil: 'networkidle' }).catch(() => {});
        submitted = true;
        break;
      }
    }

    await browser.close();

    if (submitted) {
      out({ status: 'submitted', error: null });
    } else {
      out({ status: 'error', error: 'submit_button_not_found' });
    }

  } catch (err) {
    await browser.close().catch(() => {});
    out({ status: 'error', error: err.message || 'unknown_error' });
  }
}

// ---- Entry ----
if (!command || !applicationId || !sourceUrl) {
  out({ status: 'error', error: 'usage: browser_agent.js <fill|submit> <app_id> <url> [resume|checkpoint]' });
}

switch (command) {
  case 'fill':
    fill(applicationId, sourceUrl, thirdArg).catch(err => {
      out({ status: 'error', checkpoint: {}, novel_questions: [], error: err.message });
    });
    break;
  case 'submit':
    submit(applicationId, sourceUrl, thirdArg).catch(err => {
      out({ status: 'error', error: err.message });
    });
    break;
  default:
    out({ status: 'error', error: `unknown command: ${command}` });
}
