import { RULES } from './canvas.js';
import { GRADESCOPE_ORIGIN, fetchGradescope, GradescopeError } from './gradescope.js';

const $ = (id) => document.getElementById(id);

function normalizeBase(raw) {
  let v = (raw || '').trim().replace(/\/+$/, '');
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function say(text, kind) {
  const m = $('msg');
  m.textContent = text;
  m.className = `msg ${kind || ''}`;
  m.classList.remove('hidden');
}

async function restore() {
  const cfg = await chrome.storage.local.get(
    ['base', 'token', 'badgeOn', 'intervalMin', 'stars', 'gradescopeOn']);
  $('base').value = cfg.base || '';
  $('token').value = cfg.token || '';
  $('gs-on').checked = Boolean(cfg.gradescopeOn);
  $('badge-on').checked = cfg.badgeOn !== false;
  $('interval').value = String(cfg.intervalMin || 30);
  renderStars(cfg.stars || {});
}

function renderStars(stars) {
  const box = $('stars');
  box.textContent = '';
  const ids = Object.keys(stars);
  if (!ids.length) {
    const p = document.createElement('p');
    p.className = 'help';
    p.textContent = 'None yet — click ☆ next to any announcement in the popup.';
    box.append(p);
    return;
  }
  for (const id of ids) {
    const s = stars[id];
    const row = document.createElement('div');
    row.className = 'star-row';

    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = s.title || `Announcement ${id}`;

    const sub = document.createElement('small');
    sub.textContent = s.course || '';

    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      const cur = (await chrome.storage.local.get('stars')).stars || {};
      delete cur[id];
      await chrome.storage.local.set({ stars: cur });
      renderStars(cur);
      chrome.runtime.sendMessage({ type: 'refreshBadge' }).catch(() => {});
    });

    row.append(grow, sub, del);
    box.append(row);
  }
}

// chrome.permissions.request must be called directly inside the user gesture,
// so read the fields synchronously and request before doing anything async.
$('save').addEventListener('click', () => {
  const base = normalizeBase($('base').value);
  const token = $('token').value.trim();
  if (!base) return say('Enter a valid https Canvas URL.', 'err');
  if (!token) return say('Enter your access token.', 'err');

  chrome.permissions.request({ origins: [`${base}/*`] }, async (granted) => {
    if (!granted) {
      return say('Permission denied — the extension cannot reach Canvas without it.', 'err');
    }
    await chrome.storage.local.set({
      base,
      token,
      badgeOn: $('badge-on').checked,
      intervalMin: Number($('interval').value),
      cache: null,
    });
    chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => {});
    say('Saved. Open the popup to load your agenda.', 'ok');
  });
});

$('test').addEventListener('click', async () => {
  const base = normalizeBase($('base').value);
  const token = $('token').value.trim();
  if (!base || !token) return say('Fill in both fields first.', 'err');
  say('Testing…');
  try {
    const res = await fetch(`${base}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return say('Token rejected (401/403).', 'err');
    if (!res.ok) return say(`Canvas returned HTTP ${res.status}.`, 'err');
    const me = await res.json();
    say(`Connected as ${me.name || me.short_name || 'your account'}.`, 'ok');
  } catch {
    say('Could not reach Canvas. Save first to grant permission for this domain, then retest.', 'err');
  }
});

for (const el of [$('badge-on'), $('interval')]) {
  el.addEventListener('change', async () => {
    await chrome.storage.local.set({
      badgeOn: $('badge-on').checked,
      intervalMin: Number($('interval').value),
    });
    chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => {});
  });
}

/* ---------- Gradescope ---------- */

const GS_ORIGIN_PATTERN = `${GRADESCOPE_ORIGIN}/*`;

function gsSay(text, kind) {
  const m = $('gs-msg');
  m.textContent = text;
  m.className = `msg ${kind || ''}`;
  m.classList.remove('hidden');
}

// Like the Canvas save: permissions.request has to be the first thing the
// gesture does, so no await may come before it.
$('gs-grant').addEventListener('click', () => {
  chrome.permissions.request({ origins: [GS_ORIGIN_PATTERN] }, async (granted) => {
    if (!granted) return gsSay('Permission denied — Gradescope cannot be read without it.', 'err');
    $('gs-on').checked = true;
    await chrome.storage.local.set({ gradescopeOn: true, gradescopeCache: null });
    gsSay('Granted. Open the popup to pull your Gradescope deadlines.', 'ok');
  });
});

$('gs-test').addEventListener('click', async () => {
  const ok = await chrome.permissions.contains({ origins: [GS_ORIGIN_PATTERN] });
  if (!ok) return gsSay('Grant access to gradescope.com first.', 'err');
  gsSay('Reading Gradescope…');
  try {
    const data = await fetchGradescope();
    const bits = [`${data.courses.length} course${data.courses.length === 1 ? '' : 's'}`,
      `${data.assignments.length} due in the next 14 days`];
    if (data.failed.length) bits.push(`couldn't read ${data.failed.length}`);
    gsSay(`Signed in. ${bits.join(', ')}.`, data.assignments.length ? 'ok' : '');
  } catch (err) {
    gsSay(err instanceof GradescopeError ? err.message : 'Could not read Gradescope.', 'err');
  }
});

$('gs-on').addEventListener('change', async () => {
  if ($('gs-on').checked) {
    const ok = await chrome.permissions.contains({ origins: [GS_ORIGIN_PATTERN] });
    if (!ok) {
      $('gs-on').checked = false;
      return gsSay('Grant access to gradescope.com first.', 'err');
    }
  }
  await chrome.storage.local.set({ gradescopeOn: $('gs-on').checked, gradescopeCache: null });
  gsSay($('gs-on').checked ? 'Gradescope deadlines on.' : 'Gradescope deadlines off.', 'ok');
});

const table = $('rules');
for (const [score, label, pats] of RULES) {
  const tr = document.createElement('tr');
  const words = pats.map((p) => p.source
    .replace(/\\b/g, '').replace(/\(\?:/g, '(').replace(/\\/g, '')).join(', ');
  for (const [cls, text] of [['score', score], ['label', label], ['words', words]]) {
    const td = document.createElement('td');
    td.className = cls;
    td.textContent = text;
    tr.append(td);
  }
  table.append(tr);
}

restore();
