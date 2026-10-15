// Gradescope has no API and no calendar feed, so this reads the same pages you
// do, using the session you are already signed into. Nothing is sent anywhere:
// the fetches go to gradescope.com and the results stay in this browser.
//
// Every selector below was checked against live pages. They are Gradescope's
// private markup and can change without notice, so parsing is deliberately
// loud — a deadline importer that quietly returns nothing is worse than one
// that says it is broken.

export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com';

export class GradescopeError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

// Gradescope writes "2026-09-09 14:10:00 -0700", which is not ISO 8601.
// Chrome happens to parse it, but not every engine does and the format is not
// ours to rely on, so normalise before handing it to Date.
export function parseStamp(raw) {
  if (!raw) return null;
  const iso = raw.trim().replace(' ', 'T').replace(/\s*([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  const loose = new Date(raw);
  return Number.isNaN(loose.getTime()) ? null : loose.toISOString();
}

async function getPage(path) {
  let res;
  try {
    res = await fetch(`${GRADESCOPE_ORIGIN}${path}`, {
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    });
  } catch (err) {
    // No host permission, or the request never left the browser.
    throw new GradescopeError(
      'Could not reach Gradescope — permission may not be granted for gradescope.com.', 'blocked');
  }
  if (res.status === 401 || res.status === 403) {
    throw new GradescopeError('Gradescope refused the request. Sign in and try again.', 'auth');
  }
  if (!res.ok) throw new GradescopeError(`Gradescope returned HTTP ${res.status}.`, 'http');

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A signed-out session is a 200 with the login form on it, not a 401.
  if (/\/login/.test(new URL(res.url).pathname) || doc.querySelector('form[action*="login"]')) {
    throw new GradescopeError(
      'Not signed in to Gradescope. Open gradescope.com, sign in, then refresh.', 'auth');
  }
  return doc;
}

// Courses still on the dashboard. Ones Gradescope has filed away sit inside
// .courseList--inactiveCourses, so taking only the direct children of the list
// skips years of old classes without having to guess from the term name.
export function parseCourses(doc) {
  const list = doc.querySelector('#account-show .courseList');
  if (!list) {
    throw new GradescopeError('Could not read your Gradescope course list — the page layout has changed.', 'markup');
  }
  const out = [];
  for (const block of list.querySelectorAll(':scope > .courseList--coursesForTerm')) {
    const term = block.previousElementSibling?.classList.contains('courseList--term')
      ? block.previousElementSibling.textContent.trim() : '';
    for (const a of block.querySelectorAll('a.courseBox')) {
      const href = a.getAttribute('href') || '';
      const id = href.split('/').filter(Boolean).pop();
      if (!/^\d+$/.test(id)) continue;
      out.push({
        id,
        term,
        short: a.querySelector('.courseBox--shortname')?.textContent.trim() || '',
        name: a.querySelector('.courseBox--name')?.textContent.trim() || '',
      });
    }
  }
  return out;
}

// One course's assignment table. The first .submissionTimeChart--dueDate is the
// due date; a second one, when present, is the late deadline.
export function parseAssignments(doc, course) {
  const table = doc.querySelector('#assignments-student-table');
  if (!table) return []; // a course with no student assignment table isn't an error

  const out = [];
  for (const tr of table.querySelectorAll('tbody tr[role="row"]')) {
    const head = tr.querySelector('th');
    const name = head?.textContent.trim();
    if (!name) continue;

    const stamps = [...tr.querySelectorAll('.submissionTimeChart--dueDate')]
      .map((el) => parseStamp(el.getAttribute('datetime')));
    const dueAt = stamps[0];
    if (!dueAt) continue; // no due date, nothing to put on a deadline list

    const href = head.querySelector('a')?.getAttribute('href') || '';
    const status = tr.querySelector('.submissionStatus');
    out.push({
      id: `gs:${course.id}:${name}`,
      name,
      course: course.short || course.name || `Course ${course.id}`,
      dueAt,
      lateDueAt: stamps[1] || null,
      url: href ? new URL(href, GRADESCOPE_ORIGIN).toString() : `${GRADESCOPE_ORIGIN}/courses/${course.id}`,
      // "Submitted" is the complete state; "Ungraded"/"No Submission" are not.
      submitted: Boolean(status?.classList.contains('submissionStatus-complete')),
      points: null,
      source: 'gradescope',
    });
  }
  return out;
}

// Upcoming Gradescope deadlines, shaped like the assignments canvas.js returns
// so the popup can put them in the same list.
export async function fetchGradescope({ daysAhead = 14, now = new Date() } = {}) {
  const courses = parseCourses(await getPage('/account'));
  if (!courses.length) {
    return { fetchedAt: now.toISOString(), courses: [], assignments: [], failed: [] };
  }

  const horizon = new Date(now.getTime() + daysAhead * 864e5);
  const assignments = [];
  const failed = [];
  // Sequential on purpose: this is someone's own account, not a service to
  // hammer, and a handful of courses is a second or two either way.
  for (const course of courses) {
    try {
      const doc = await getPage(`/courses/${course.id}`);
      for (const a of parseAssignments(doc, course)) {
        const due = new Date(a.dueAt);
        if (due >= now && due <= horizon) assignments.push(a);
      }
    } catch (err) {
      if (err instanceof GradescopeError && err.kind === 'auth') throw err;
      failed.push(course.short || course.id); // one dead course shouldn't sink the rest
    }
  }
  assignments.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return {
    fetchedAt: now.toISOString(),
    courses: courses.map((c) => c.short || c.name),
    assignments,
    failed,
  };
}
