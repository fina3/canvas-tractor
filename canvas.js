// Canvas API client + announcement priority scoring.
// Shared by the popup and the background service worker.

export const IMPORTANT_THRESHOLD = 75;

// [baseScore, label, patterns]. Highest matching rule wins.
// A hit in the title scores full; a body-only hit scores 60%.
export const RULES = [
  [100, 'CANCELLED', [/\bcancel?l?ed\b/i, /\bcancellation\b/i, /\bno class\b/i,
    /\bnot? (be )?meeting\b/i, /\bclass (is |will be )?(cancel|off)/i, /\blecture cancel/i]],
  [95, 'RESCHEDULED', [/\bresched/i, /\bpostpon/i, /\bmoved to\b/i,
    /\bnew (time|date|room|location)\b/i, /\broom change\b/i, /\blocation change\b/i,
    /\brelocat/i, /\bdate change\b/i]],
  [90, 'EXAM', [/\bexam\b/i, /\bmidterm\b/i, /\bfinals?\b/i, /\bquiz\b/i, /\bpractical\b/i,
    /\bproctor/i, /\bblue ?book\b/i, /\bcheat sheet\b/i, /\bstudy guide\b/i, /\breview session\b/i]],
  [85, 'DEADLINE', [/\bdue date\b/i, /\bdeadline\b/i, /\bextend(ed|ing|sion)?\b/i,
    /\bdue (tonight|tomorrow|today)\b/i, /\blate (policy|penalty|submission)\b/i,
    /\bresubmit/i, /\bgrace period\b/i]],
  [75, 'URGENT', [/\burgent\b/i, /\bimportant\b/i, /\bplease read\b/i, /\baction required\b/i,
    /\basap\b/i, /\bimmediately\b/i, /\breminder\b/i]],
  [60, 'GRADES', [/\bgrades?\b/i, /\bregrade\b/i,
    /\bscores? (are|have been|were) (posted|released|up)\b/i, /\brubric\b/i, /\bcurve\b/i]],
  [40, 'LOGISTICS', [/\boffice hours?\b/i, /\bzoom link\b/i, /\bdiscussion section\b/i,
    /\bguest (lecture|speaker)\b/i, /\bslides? (are |have been )?(posted|up)\b/i, /\brecording\b/i]],
];

const BLOCKS = 'p, div, li, tr, br, h1, h2, h3, h4, h5, h6, blockquote, section, article';

// Collapse runs of spaces but keep paragraph breaks, so an expanded announcement
// reads the way it was written instead of running sentences together.
function tidy(s) {
  return s
    .replace(/[ \t\u00a0\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Words worth spotting inside body text. Deliberately separate from the RULES
// scoring above: highlighting can be tuned without changing what counts as
// important. Only the high-signal categories are bolded — bolding "office
// hours" and "recording" too would leave half the paragraph in bold.
const HIGHLIGHT_MIN_SCORE = 75;
const HIGHLIGHT_EXTRA = [
  /\bassignments?\b/i, /\bhomework\b/i, /\bproblem sets?\b/i,
  /\bprojects?\b/i, /\blabs?\b/i, /\bessays?\b/i, /\bpapers?\b/i,
];

const HIGHLIGHT_RE = new RegExp(
  [...RULES.filter(([base]) => base >= HIGHLIGHT_MIN_SCORE).flatMap(([, , pats]) => pats),
    ...HIGHLIGHT_EXTRA].map((p) => `(?:${p.source})`).join('|'), 'gi');

// [start, end] offsets of every keyword hit, merged where they overlap so the
// caller can splice the string without producing nested or crossing ranges.
export function keywordRanges(text) {
  const out = [];
  if (!text) return out;
  HIGHLIGHT_RE.lastIndex = 0;
  for (let m; (m = HIGHLIGHT_RE.exec(text)) !== null;) {
    if (!m[0]) { HIGHLIGHT_RE.lastIndex += 1; continue; }
    const start = m.index;
    const end = start + m[0].length;
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

export function stripHtml(s) {
  if (!s) return '';
  const doc = new DOMParser().parseFromString(s, 'text/html');
  // textContent alone welds "…cancelled.</p><p>I am out sick" into one word.
  for (const node of doc.body.querySelectorAll(BLOCKS)) node.after('\n');
  return tidy(doc.body.textContent || '');
}

// Service workers have no DOMParser, so decode entities by hand there.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  bull: '\u2022', deg: '\u00b0', trade: '\u2122', copy: '\u00a9', reg: '\u00ae',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : whole;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

function plainText(s) {
  if (!s) return '';
  if (typeof DOMParser !== 'undefined') return stripHtml(s);
  const text = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>|<\/blockquote>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(text));
}

export function scoreAnnouncement(ann, starIds = new Set()) {
  const title = ann.title || '';
  const body = plainText(ann.message).slice(0, 4000);
  let score = 0;
  const labels = [];
  for (const [base, label, pats] of RULES) {
    const inTitle = pats.some((p) => p.test(title));
    const inBody = !inTitle && pats.some((p) => p.test(body));
    if (inTitle || inBody) {
      labels.push(label);
      score = Math.max(score, inTitle ? base : Math.round(base * 0.6));
    }
  }
  if (ann.pinned) { score += 30; labels.push('PINNED'); }
  if (ann.read_state === 'unread') score += 5;
  if (starIds.has(String(ann.id))) { score += 1000; labels.unshift('STARRED'); }
  return { score: Math.min(score, 1099), labels };
}

export class CanvasError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

async function getAll(base, token, path, params = {}) {
  const url = new URL(`${base.replace(/\/+$/, '')}/api/v1${path}`);
  url.searchParams.set('per_page', '100');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  let next = url.toString();
  const out = [];
  let pages = 0;
  while (next && pages < 20) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      throw new CanvasError('Token rejected by Canvas (401/403). Re-check your access token.', 'auth');
    }
    if (res.status === 404) {
      throw new CanvasError(`Not found (404) at ${path}. Check your Canvas URL.`, 'notfound');
    }
    if (!res.ok) throw new CanvasError(`Canvas returned HTTP ${res.status}.`, 'http');
    const body = await res.json();
    out.push(...(Array.isArray(body) ? body : [body]));
    next = parseNextLink(res.headers.get('Link'));
    pages += 1;
  }
  return out;
}

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export async function fetchAgenda({ base, token, daysAhead = 14, daysBack = 14, stars = {} }) {
  const now = new Date();
  const starIds = new Set(Object.keys(stars));

  const rawCourses = await getAll(base, token, '/courses', {
    enrollment_state: 'active',
    'state[]': 'available',
  });
  const courses = rawCourses.filter((c) => c.id && !c.access_restricted_by_date);
  if (!courses.length) {
    throw new CanvasError('No active courses found for this token.', 'empty');
  }
  const nameById = new Map(courses.map((c) => [c.id, c.name || c.course_code || String(c.id)]));

  // Announcements for every course in one batched call.
  const since = new Date(now.getTime() - daysBack * 864e5);
  const rawAnn = await getAll(base, token, '/announcements', {
    'context_codes[]': courses.map((c) => `course_${c.id}`),
    start_date: since.toISOString(),
    end_date: now.toISOString(),
    active_only: 'true',
  });

  const announcements = rawAnn.map((a) => {
    const { score, labels } = scoreAnnouncement(a, starIds);
    const cid = a.context_code ? Number(a.context_code.split('_')[1]) : null;
    // Keep the full text so the popup can expand a row without a second fetch.
    const body = plainText(a.message).slice(0, 4000);
    return {
      id: String(a.id),
      title: a.title || '(untitled)',
      course: nameById.get(cid) || 'Unknown course',
      postedAt: a.posted_at,
      url: a.html_url,
      unread: a.read_state === 'unread',
      snippet: body.slice(0, 220),
      body,
      score,
      labels,
    };
  }).sort((a, b) => b.score - a.score
    || String(b.postedAt || '').localeCompare(String(a.postedAt || '')));

  // Upcoming assignments, per course.
  const horizon = new Date(now.getTime() + daysAhead * 864e5);
  const assignments = [];
  const perCourse = await Promise.all(courses.map(async (c) => {
    try {
      return [c, await getAll(base, token, `/courses/${c.id}/assignments`,
        { bucket: 'upcoming', order_by: 'due_at' })];
    } catch {
      return [c, []]; // one dead course shouldn't sink the whole popup
    }
  }));
  for (const [c, list] of perCourse) {
    for (const a of list) {
      if (!a.due_at) continue;
      const due = new Date(a.due_at);
      if (due < now || due > horizon) continue;
      assignments.push({
        id: String(a.id),
        name: a.name || '(untitled)',
        course: nameById.get(c.id),
        dueAt: a.due_at,
        points: a.points_possible,
        url: a.html_url,
        submitted: Boolean(a.submission && a.submission.submitted_at),
      });
    }
  }
  assignments.sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  return {
    fetchedAt: now.toISOString(),
    courses: [...nameById.values()],
    announcements,
    assignments,
  };
}
