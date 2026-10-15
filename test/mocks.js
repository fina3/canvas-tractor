// Test-only stubs so popup.html can run in an ordinary tab.
// Fakes chrome.storage.local, chrome.runtime and the Canvas REST API.

const store = {
  base: 'https://mock.instructure.test',
  token: 'mock-token',
  importantOnly: false,
  stars: {},
  note: 'ask about the regrade window in office hours',
};

// Patch the page's existing `chrome` in place rather than replacing it: the
// browser-automation extension talks to this page through the real
// chrome.runtime, and clobbering it hangs script injection.
const c = globalThis.chrome || (globalThis.chrome = {});
c.storage = {
  local: {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) { Object.assign(store, structuredClone(obj)); },
  },
};
if (!c.runtime) c.runtime = {};
const nativeSend = c.runtime.sendMessage;
const OURS = new Set(['refreshBadge', 'reschedule']);
c.runtime.sendMessage = function (...args) {
  if (args[0] && OURS.has(args[0].type)) {
    console.log('[mock] sendMessage', JSON.stringify(args[0]));
    (globalThis.__sent || (globalThis.__sent = [])).push(args[0]);
    return Promise.resolve({ ok: true });
  }
  return nativeSend ? nativeSend.apply(this, args) : Promise.resolve();
};
c.runtime.openOptionsPage = () => console.log('[mock] openOptionsPage');

globalThis.__store = store;
globalThis.__sent = []; // for assertions from the test driver

const COURSES = [
  { id: 1, name: 'STAT 24 — Data Science Connector' },
  { id: 2, name: 'CS 61B — Data Structures' },
];

function ann(id, course, title, message, extra = {}) {
  return {
    id, title, message,
    context_code: `course_${course}`,
    posted_at: new Date(Date.now() - id * 36e5).toISOString(),
    html_url: `https://mock.instructure.test/courses/${course}/discussion_topics/${id}`,
    read_state: 'unread',
    ...extra,
  };
}

const ANNOUNCEMENTS = [
  ann(11, 1, 'Lecture cancelled Thursday',
    '<p>Thursday&rsquo;s lecture is <strong>cancelled</strong>.</p><p>I am out sick. The recording ' +
    'from last spring covers the same material and is posted under Modules &rarr; Week 6. ' +
    'Office hours still run at their usual time, and the reading response is still due Friday.</p>'),
  ann(12, 2, 'Midterm 2 room change',
    '<p>Midterm 2 has a <em>new room</em>: Dwinelle 155, not Pimentel.</p><p>Bring a blue book and ' +
    'one double-sided cheat sheet. Doors open 10 minutes early; arrive on time.</p>', { pinned: true }),
  ann(13, 1, 'Project 2 deadline extended',
    '<p>The Project 2 deadline moves to Sunday 11:59pm. The late policy is unchanged after that.</p>'),
  ann(14, 2, 'Grades posted for Lab 4',
    '<p>Lab 4 scores are up. Regrade requests close in one week &mdash; see the rubric on the site.</p>'),
  ann(15, 1, 'Office hours moved to Zoom this week',
    '<p>Office hours are on Zoom this week; the link is in the syllabus. Slides are posted.</p>',
    { read_state: 'read' }),
  ann(16, 2, 'Guest lecture Friday',
    '<p>A guest speaker from industry joins us Friday. Attendance is optional but recommended.</p>',
    { read_state: 'read' }),
];

function assignments(courseId) {
  const mk = (id, name, hours, points, submitted) => ({
    id, name, points_possible: points,
    due_at: new Date(Date.now() + hours * 36e5).toISOString(),
    html_url: `https://mock.instructure.test/courses/${courseId}/assignments/${id}`,
    submission: submitted ? { submitted_at: new Date().toISOString() } : null,
  });
  return courseId === 1
    ? [mk(101, 'Reading response 6', 20, 10, false), mk(102, 'Lab 7', 96, 25, false)]
    : [mk(201, 'Project 2 checkpoint', 8, 40, false), mk(202, 'Homework 9', 150, 30, true)];
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  // Anything that isn't a mock-Canvas call goes to the real fetch untouched,
  // including relative URLs from other scripts running on the page.
  let url;
  try {
    url = new URL(input instanceof Request ? input.url : String(input), location.href);
  } catch {
    return realFetch(input, init);
  }
  if (!url.hostname.endsWith('instructure.test')) return realFetch(input, init);
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const p = url.pathname;
  if (p === '/api/v1/courses') return json(COURSES);
  if (p === '/api/v1/announcements') return json(ANNOUNCEMENTS);
  const m = p.match(/^\/api\/v1\/courses\/(\d+)\/assignments$/);
  if (m) return json(assignments(Number(m[1])));
  return json([]);
};
