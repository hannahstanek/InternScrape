/**
 * normalize.js
 * Core normalization and eligibility logic.
 * Used by n8n Code nodes (paste inline) or called via Execute Command.
 *
 * All functions are pure — no I/O, no side effects.
 * Pass config objects in; receive normalized/scored results back.
 */

const crypto = require('crypto');

// ---- Job Key ----

function computeJobKey(companyId, postingId) {
  return crypto
    .createHash('sha256')
    .update(`${companyId}::${postingId}`)
    .digest('hex');
}

// ---- Title ----

function normalizeTitle(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')      // remove parenthetical suffixes
    .replace(/\[.*?\]/g, '')      // remove bracketed labels
    .replace(/req#?\s*\d+/gi, '') // strip requisition numbers
    .replace(/[-–—|]/g, ' ')     // normalize separators
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Posting ID Extraction ----

function extractPostingId(url, pageId) {
  if (pageId) return String(pageId).trim();

  const patterns = [
    /\/jobs?\/(\d+)/i,
    /\/positions?\/(\d+)/i,
    /[?&](?:job_?id|jobId|requisition_?id|req_?id|jid)=([^&]+)/i,
    /\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i, // UUID
    /\/([A-Z]{2,}-\d+)/i,         // Jira-style IDs like APPL-12345
    /gh\/(\d+)/i,                  // Greenhouse shorthand
    /lever\.co\/\w+\/([^/?]+)/i,  // Lever job slug
  ];

  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }

  // fallback: hash of URL path
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

// ---- Location ----

function normalizeLocation(raw, locationPolicy) {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();

  const check = (labels) => labels.some(l => lower.includes(l.toLowerCase()));

  const isRemote = check(locationPolicy.remote_labels);
  const isAustin = check(locationPolicy.austin_metro_labels);
  const isSanAntonio = check(locationPolicy.san_antonio_metro_labels);
  const isHardReject = check(locationPolicy.hard_reject_if_only) &&
    !isRemote && !isAustin && !isSanAntonio;
  const isAmbiguous = check(locationPolicy.ambiguous_triggers) &&
    !isRemote && !isAustin && !isSanAntonio;

  if (isHardReject) return 'rejected';
  if (isRemote) return 'remote';
  if (isAustin) return 'austin_metro';
  if (isSanAntonio) return 'san_antonio_metro';
  if (isAmbiguous) return 'unknown'; // triggers needs_attention
  return 'rejected';
}

// ---- Term Detection ----

function detectTerm(title, description, roleFilters) {
  const haystack = `${title} ${description || ''}`.toLowerCase();
  const matched = roleFilters.require_term.find(t => haystack.includes(t.toLowerCase()));
  return matched ? 'fall_2026' : null;
}

// ---- Type Detection ----

function detectType(title, description, roleFilters) {
  const haystack = `${title} ${description || ''}`.toLowerCase();
  return roleFilters.require_type.some(t => haystack.includes(t.toLowerCase()));
}

// ---- Role Family Detection ----

function detectRoleFamily(titleNormalized, description, roleFilters) {
  const haystack = `${titleNormalized} ${description || ''}`.toLowerCase();

  for (const [family, cfg] of Object.entries(roleFilters.role_families)) {
    const hasExclusion = cfg.exclusions.some(ex => haystack.includes(ex.toLowerCase()));
    if (hasExclusion) continue;

    const matchedKeywords = cfg.title_keywords.filter(kw =>
      haystack.includes(kw.toLowerCase())
    );
    if (matchedKeywords.length > 0) {
      return { family, matched: matchedKeywords };
    }
  }
  return null;
}

// ---- Global Exclusion Check ----

function hasGlobalExclusion(titleNormalized, roleFilters) {
  const lower = titleNormalized.toLowerCase();
  return roleFilters.global_exclusions.some(ex => lower.includes(ex.toLowerCase()));
}

// ---- Score ----

function scoreJob(job, companyTier, roleFilters) {
  const scoring = roleFilters.scoring;
  let score = 0;

  if (job.role_family) {
    score += scoring.title_match_weight * (job.match_tags.length > 0 ? 1 : 0);
  }

  const tierBonus = scoring[`tier_${companyTier}_bonus`] || 0;
  score += tierBonus;

  return score;
}

// ---- Full Eligibility Pipeline ----

function evaluateJob({ raw, company, roleFilters, locationPolicy }) {
  const titleNorm = normalizeTitle(raw.title);
  const postingId = extractPostingId(raw.url, raw.posting_id);
  const jobKey = computeJobKey(company.company_id, postingId);
  const locationNorm = normalizeLocation(raw.location, locationPolicy);

  // Reject immediately if location is hard-rejected
  if (locationNorm === 'rejected') {
    return {
      job_key: jobKey,
      posting_id: postingId,
      title_normalized: titleNorm,
      location_normalized: locationNorm,
      status: 'filtered_out',
      filter_reason: `location_rejected: "${raw.location}"`,
      role_family: null,
      match_tags: [],
      match_score: 0,
    };
  }

  // Check global exclusions
  if (hasGlobalExclusion(titleNorm, roleFilters)) {
    return {
      job_key: jobKey,
      posting_id: postingId,
      title_normalized: titleNorm,
      location_normalized: locationNorm,
      status: 'filtered_out',
      filter_reason: `global_exclusion matched in title`,
      role_family: null,
      match_tags: [],
      match_score: 0,
    };
  }

  // Check internship type
  if (!detectType(raw.title, raw.description, roleFilters)) {
    return {
      job_key: jobKey,
      posting_id: postingId,
      title_normalized: titleNorm,
      location_normalized: locationNorm,
      status: 'filtered_out',
      filter_reason: `not_internship: no intern/coop keyword in title or description`,
      role_family: null,
      match_tags: [],
      match_score: 0,
    };
  }

  // Check term
  const term = detectTerm(raw.title, raw.description, roleFilters);
  if (!term) {
    return {
      job_key: jobKey,
      posting_id: postingId,
      title_normalized: titleNorm,
      location_normalized: locationNorm,
      status: 'filtered_out',
      filter_reason: `wrong_term: fall 2026 not found`,
      role_family: null,
      match_tags: [],
      match_score: 0,
    };
  }

  // Check role family
  const familyResult = detectRoleFamily(titleNorm, raw.description, roleFilters);
  if (!familyResult) {
    return {
      job_key: jobKey,
      posting_id: postingId,
      title_normalized: titleNorm,
      location_normalized: locationNorm,
      status: 'filtered_out',
      filter_reason: `no_role_family_match: title does not match ai_ml, security, or product_management`,
      role_family: null,
      match_tags: [],
      match_score: 0,
    };
  }

  const score = scoreJob(
    { role_family: familyResult.family, match_tags: familyResult.matched },
    company.tier,
    roleFilters
  );

  // Ambiguous location goes to needs_attention, not filtered_out
  const finalStatus = locationNorm === 'unknown' ? 'needs_attention' : 'eligible';

  return {
    job_key: jobKey,
    posting_id: postingId,
    title_normalized: titleNorm,
    location_normalized: locationNorm,
    term,
    role_family: familyResult.family,
    match_tags: familyResult.matched,
    match_score: score,
    status: finalStatus,
    filter_reason: locationNorm === 'unknown'
      ? `ambiguous_location: "${raw.location}" — manual review required`
      : null,
  };
}

module.exports = {
  computeJobKey,
  normalizeTitle,
  extractPostingId,
  normalizeLocation,
  detectTerm,
  detectType,
  detectRoleFamily,
  hasGlobalExclusion,
  scoreJob,
  evaluateJob,
};
