import { fetchAgenda, CanvasError, IMPORTANT_THRESHOLD, keywordRanges } from './canvas.js';
import { DAY, isRepeating, occurrencesOf, ruleFor, shiftAnchor } from './recur.js';
import { fetchGradescope, GradescopeError } from './gradescope.js';

const $ = (id) => document.getElementById(id);
const UNDO_LIMIT = 50;
// A popup is torn down the moment it loses focus, so the note is written back
// quickly and flushed again on the way out rather than left to a long debounce.
const NOTE_SAVE_MS = 200;

const state = {
  data: null,
  gradescope: null, // upcoming Gradescope deadlines, cached like the Canvas ones
  stars: {},
  importantOnly: false,
  done: {},        // assignment id -> when it was ticked off
  collapsed: { done: true }, // Done starts folded away; To do starts open
  dismissed: {},   // id -> a self-contained copy of the binned announcement
  events: {},      // id -> a deadline typed in by hand (Gradescope, an exam, …)
  undoStack: [],   // each entry: { label, store, before: {id: entry|null}, after: {…} }
  redoStack: [],
  expanded: new Set(),
  menuFor: null,    // id of the row whose ⋯ menu is open
  editing: null,    // { baseId, baseAt } while the form is editing, not adding
  pendingEdit: null, // a validated edit waiting on "just this one / all of them"
  resortAnn: false, // a star changed the ranking; apply it on the way back in
  errorShown: false,
};

function relative(iso) {
  const ms = new Date(iso) - Date.now();
  const h = ms / 36e5;
  if (h < 0) return `${Math.abs(h) < 24 ? `${Math.round(-h)}h` : `${Math.round(-h / 24)}d`} ago`;
  if (h < 1) return `in ${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `in ${Math.round(h)}h`;
  return `in ${Math.round(h / 24)}d`;
}

function dueClass(iso) {
  const h = (new Date(iso) - Date.now()) / 36e5;
  return h < 24 ? 'soon' : h < 72 ? 'near' : '';
}

function shortDate(iso) {
  return new Date(iso).toLocaleString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function link(href, text) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

function iconBtn(cls, glyph, title, onClick) {
  const b = el('button', cls, glyph);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function showStatus(msg, isError, actionLabel, onAction) {
  const s = $('status');
  s.textContent = '';
  s.className = `status${isError ? ' error' : ''}`;
  s.append(document.createTextNode(msg + ' '));
  if (actionLabel) {
    const b = el('button', 'link', actionLabel);
    b.addEventListener('click', onAction);
    s.append(b);
  }
  s.classList.remove('hidden');
  state.errorShown = Boolean(isError);
}

function hideStatus() { $('status').classList.add('hidden'); state.errorShown = false; }

// Transient note for undoable actions; never stomps a visible error.
let flashTimer = null;
function flash(msg) {
  if (state.errorShown) return;
  showStatus(msg, false, 'Undo', undo);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!state.errorShown) hideStatus(); }, 4000);
}

/* ---------- bin + undo/redo ---------- */

// A change is a set of id -> entry-or-null transitions against one keyed store,
// so dismiss, restore, empty-bin and adding or removing a hand-typed deadline
// all share the same undo machinery — and one Cmd+Z reverses whichever of them
// you did last.
function commit(label, after, store = 'dismissed') {
  const target = state[store];
  const before = {};
  for (const id of Object.keys(after)) before[id] = target[id] || null;
  const change = { label, store, before, after };
  state.undoStack.push(change);
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  state.redoStack = [];
  return applyChange(change, 'after');
}

async function applyChange(change, side) {
  // Stacks written before events existed have no `store`; they were all bin.
  const target = state[change.store || 'dismissed'];
  for (const [id, entry] of Object.entries(change[side])) {
    if (entry) target[id] = entry;
    else delete target[id];
  }
  await persist();
  render();
  chrome.runtime.sendMessage({ type: 'refreshBadge' }).catch(() => {});
}

async function persist() {
  await chrome.storage.local.set({
    dismissed: state.dismissed,
    events: state.events,
    undoStack: state.undoStack,
    redoStack: state.redoStack,
  });
}

async function undo() {
  const change = state.undoStack.pop();
  if (!change) return;
  state.redoStack.push(change);
  await applyChange(change, 'before');
  flashDone(`Undid: ${change.label}.`);
}

async function redo() {
  const change = state.redoStack.pop();
  if (!change) return;
  state.undoStack.push(change);
  await applyChange(change, 'after');
  flashDone(`Redid: ${change.label}.`);
}

// Undo/redo feedback without an "Undo" link — the header buttons cover it.
function flashDone(msg) {
  if (state.errorShown) return;
  showStatus(msg, false);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!state.errorShown) hideStatus(); }, 2500);
}

// Store enough with each binned item that the bin still renders after the
// announcement ages out of Canvas's 14-day window.
function binEntry(a) {
  return {
    id: a.id,
    title: a.title,
    course: a.course,
    url: a.url,
    postedAt: a.postedAt,
    snippet: a.snippet,
    body: a.body,
    labels: a.labels,
    score: a.score,
    at: new Date().toISOString(),
  };
}

function dismiss(a) {
  state.expanded.delete(a.id);
  commit(`dismissed "${a.title}"`, { [a.id]: binEntry(a) });
  flash('Moved to bin.');
}

function restore(entry) {
  commit(`restored "${entry.title}"`, { [entry.id]: null });
  flash('Restored.');
}

// Emptying leaves a tombstone rather than deleting the key: dropping the entry
// entirely would un-dismiss the announcement and float it back into the list.
// The undo stack still holds the full entry, so undo puts it back in the bin.
function emptyBin() {
  const items = binItems();
  if (!items.length) return;
  commit(`emptied bin (${items.length})`,
    Object.fromEntries(items.map((e) => [e.id, { id: e.id, title: e.title, at: e.at, purged: true }])));
  flash(`Emptied bin (${items.length}).`);
}

// What the bin shows: dismissed, but not yet emptied out of it.
function binItems() {
  return Object.values(state.dismissed)
    .filter((e) => !e.purged)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/* ---------- hand-added deadlines ---------- */

// Not everything with a deadline lives in Canvas: Gradescope-hosted labs, an
// exam announced out loud in lecture. These are typed in here, kept in
// chrome.storage.local like the ticks and stars, and merged into the same Due
// list — one list to read, rather than one per system.
const EVENT_PREFIX = 'evt:';

// A ticked-off deadline is history once it is well past; drop it rather than
// growing the store forever. Untouched ones are left alone — an overdue thing
// that quietly disappeared would be worse than a stale row.
const EVENT_KEEP_DAYS = 14;

// How far ahead a repeating deadline is spelled out: the same 14 days canvas.js
// fetches, plus a day of grace so one you have only just missed is still in
// front of you rather than gone by morning.
const AHEAD_DAYS = 14;
const GRACE_DAYS = 1;

// Dates are generated over a wider span than the list shows, then filtered on
// where they actually land: a single date moved by an override can be dragged
// into or out of the visible window, and should be judged on where it ended up.
const SCAN_DAYS = 60;

function pruneEvents() {
  const cutoff = Date.now() - EVENT_KEEP_DAYS * DAY;
  for (const [id, e] of Object.entries(state.events)) {
    // A ticked-off one-off is history once it is well past. A series is not:
    // ticking off this week's homework says nothing about next week's.
    if (!isRepeating(e) && state.done[`${id}@${e.at}`] && new Date(e.at) < cutoff) {
      delete state.events[id];
    }
  }
  // Ticks are keyed by the individual date, so a weekly deadline would
  // otherwise leave one behind for every week of the term.
  for (const key of Object.keys(state.done)) {
    if (!key.startsWith(EVENT_PREFIX)) continue;
    const at = key.slice(key.indexOf('@') + 1);
    if (at && new Date(at) < cutoff) delete state.done[key];
  }
}

// One changed date of a series, if this one has been edited on its own.
const overrideAt = (e, baseAt) => (e.overrides || {})[baseAt] || null;

// Shaped like an assignment from canvas.js so dueRow can render either. One
// date of a series is its own row, ticked off and edited on its own, so `id`
// carries the date it came from. `baseAt` stays the date the rule generated
// even when an override has moved it, so ticks and further edits keep pointing
// at the same one.
function eventItem(e, baseAt) {
  const o = overrideAt(e, baseAt);
  return {
    id: `${e.id}@${baseAt}`,
    baseId: e.id,
    baseAt,
    name: o ? o.title : e.title,
    // No filler when you didn't name a course: the ADDED pill already says
    // where the row came from, so "Added by you" next to it just says it twice.
    course: (o ? o.course : e.course) || '',
    dueAt: o?.at || baseAt,
    points: null,
    url: null,
    submitted: false,
    manual: true,
    edited: Boolean(o),
    repeat: isRepeating(e) ? ruleFor(e).every : null,
  };
}

// Canvas assignments plus hand-added deadlines, in one chronological list.
function dueItems() {
  const now = Date.now();
  const from = new Date(now - GRACE_DAYS * DAY);
  const to = new Date(now + AHEAD_DAYS * DAY);
  const manual = [];
  for (const e of Object.values(state.events)) {
    // A one-off shows whenever it falls, past the horizon or overdue: that
    // exact date was typed in on purpose. A series is only spelled out as far
    // as the list looks — nobody needs to see all 15 physics deadlines.
    if (!isRepeating(e)) { manual.push(eventItem(e, e.at)); continue; }
    const scanFrom = new Date(now - SCAN_DAYS * DAY);
    const scanTo = new Date(now + SCAN_DAYS * DAY);
    for (const baseAt of occurrencesOf(e, scanFrom, scanTo)) {
      const item = eventItem(e, baseAt);
      const at = new Date(item.dueAt);
      if (at >= from && at <= to) manual.push(item);
    }
  }
  return [...(state.data?.assignments || []), ...(state.gradescope?.assignments || []), ...manual]
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}

// `pre` opens the form on an existing deadline instead of a blank one.
function openForm(open, pre) {
  $('event-form').classList.toggle('hidden', !open);
  $('add-event').setAttribute('aria-expanded', String(open));
  $('event-error').textContent = '';
  showScope(false);
  if (!open) {
    state.editing = null;
    state.pendingEdit = null;
    return;
  }
  state.editing = pre ? { baseId: pre.baseId, baseAt: pre.baseAt } : null;
  $('event-title').value = pre ? pre.title : '';
  $('event-course').value = pre ? pre.course || '' : '';
  $('event-when').value = pre ? toLocalInput(pre.at) : defaultWhen();
  $('event-repeat').value = pre ? pre.repeat || 'none' : 'none';
  $('event-until').value = pre ? pre.until || '' : '';
  $('event-save').textContent = pre ? 'Save' : 'Add';
  syncRepeat();
  $('event-title').focus();
}

// The value a datetime-local input wants: local wall-clock, no zone.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Prefill the next 11:59pm — where a student deadline usually lands — so the
// common case is a title and Enter.
function defaultWhen() {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return toLocalInput(d.toISOString());
}

function startEdit(a) {
  const e = state.events[a.baseId];
  if (!e) return;
  const o = overrideAt(e, a.baseAt);
  openForm(true, {
    baseId: a.baseId,
    baseAt: a.baseAt,
    title: o ? o.title : e.title,
    course: o ? o.course : e.course,
    at: o?.at || a.baseAt,
    repeat: e.repeat || 'none',
    until: e.until || '',
  });
}

// Reads and checks the form. Returns null and says what's wrong if it can't.
function readForm() {
  const title = $('event-title').value.trim();
  const when = $('event-when').value;
  if (!title) { formError('Give it a name.', 'event-title'); return null; }
  // datetime-local hands back local wall-clock time; store the instant.
  const at = new Date(when);
  if (!when || Number.isNaN(at.getTime())) { formError('Pick a date and time.', 'event-when'); return null; }

  const repeat = $('event-repeat').value;
  const until = repeat === 'none' ? '' : $('event-until').value;
  if (until && new Date(`${until}T23:59:59`) < at) {
    formError('That end date is before the first one.', 'event-until');
    return null;
  }
  return { title, course: $('event-course').value.trim(), at: at.toISOString(), repeat, until };
}

function submitForm() {
  const form = readForm();
  if (!form) return;
  if (!state.editing) { addEvent(form); return; }

  // Editing one date of a series is ambiguous — this Friday, or every Friday?
  // Ask rather than guess. A one-off has only one answer, so it just saves.
  const e = state.events[state.editing.baseId];
  if (e && isRepeating(e)) { state.pendingEdit = form; showScope(true); return; }
  applyEdit('all', form);
}

function addEvent(form) {
  const id = `${EVENT_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, ...form, added: new Date().toISOString() };
  openForm(false);
  commit(`added "${form.title}"`, { [id]: entry }, 'events');
  flash(isRepeating(entry) ? `Added, ${ruleFor(entry).label.toLowerCase()}.` : 'Deadline added.');
}

function showScope(on) {
  $('event-scope').classList.toggle('hidden', !on);
  $('event-foot').classList.toggle('hidden', on);
  if (!on) return;
  $('event-error').textContent = '';
  $('scope-one').focus();
}

function applyEdit(scope, form) {
  const edit = form || state.pendingEdit;
  const { baseId, baseAt } = state.editing || {};
  const e = state.events[baseId];
  if (!e || !edit) { openForm(false); return; }

  let next;
  if (scope === 'one') {
    // Carve this date out of the series, leaving the rule itself alone.
    next = { ...e, overrides: { ...(e.overrides || {}), [baseAt]: {
      title: edit.title, course: edit.course, at: edit.at,
    } } };
  } else {
    // "All of them" moves the whole series by however far this date moved, so
    // it keeps its cadence, and supersedes any single dates carved out of it.
    next = { ...e, title: edit.title, course: edit.course, repeat: edit.repeat, until: edit.until };
    next.at = isRepeating(next) ? shiftAnchor(e.at, baseAt, edit.at) : edit.at;
    next.overrides = {};
  }
  openForm(false);
  commit(`edited "${edit.title}"`, { [baseId]: next }, 'events');
  flash(scope === 'one' ? 'Changed this one only.' : 'Changed every date.');
}

// Stop the series at this date: everything from here on goes, everything
// already behind you stays, so a term that ends early doesn't erase the record.
function cancelFuture(a) {
  const e = state.events[a.baseId];
  if (!e) return;
  const from = new Date(a.baseAt);
  if (from <= new Date(e.at)) { removeEvent(a); return; } // nothing earlier survives
  const dayBefore = new Date(from);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  const until = `${dayBefore.getFullYear()}-${pad(dayBefore.getMonth() + 1)}-${pad(dayBefore.getDate())}`;
  commit(`cancelled "${e.title}" from ${shortDate(a.dueAt)}`, { [a.baseId]: { ...e, until } }, 'events');
  flash('Cancelled this one and every later one.');
}

// The end date only means anything once something repeats.
function syncRepeat() {
  $('event-until-wrap').classList.toggle('hidden', $('event-repeat').value === 'none');
}

function formError(msg, focusId) {
  $('event-error').textContent = msg;
  $(focusId).focus();
}

function removeEvent(a) {
  const e = state.events[a.baseId];
  if (!e) return;
  commit(`removed "${e.title}"`, { [a.baseId]: null }, 'events');
  flash(isRepeating(e) ? 'Repeating deadline removed — every date.' : 'Deadline removed.');
}

/* ---------- notes ---------- */

let noteTimer = null;

function noteStatus(text) { $('note-status').textContent = text; }

async function saveNote() {
  noteTimer = null;
  try {
    await chrome.storage.local.set({ note: $('note').value });
    noteStatus('Saved');
  } catch (err) {
    noteStatus('Could not save');
  }
}

function scheduleNoteSave() {
  noteStatus('Saving…');
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, NOTE_SAVE_MS);
}

function flushNote() {
  if (noteTimer === null) return;
  clearTimeout(noteTimer);
  saveNote();
}

/* ---------- rendering ---------- */

// Submitted on Canvas, or ticked off here. Canvas has no per-student "done"
// flag for an assignment you haven't submitted, so the tick is kept locally
// the same way stars are.
const isDone = (a) => Boolean(a.submitted) || Boolean(state.done[a.id]);

// The ⋯ menu on a hand-added row. Only one is open at a time, and rendering is
// driven from state so it survives the list being rebuilt underneath it.
function rowMenu(a) {
  const wrap = el('div', 'menu-wrap');
  const open = state.menuFor === a.id;
  const btn = iconBtn('x-btn menu-btn', '⋯', 'Edit or remove this deadline', () => {
    state.menuFor = open ? null : a.id;
    renderDue();
  });
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', String(open));
  wrap.append(btn);
  if (!open) return wrap;

  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const item = (label, cls, fn) => {
    const b = el('button', `menu-item${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close it here rather than leaving it to whatever the action does next:
      // "Edit…" only opens the form, and the menu would sit there over the top.
      state.menuFor = null;
      renderDue();
      fn();
    });
    return b;
  };
  menu.append(item('Edit…', '', () => startEdit(a)));
  if (a.repeat) {
    menu.append(item('Cancel this and every later one', '', () => cancelFuture(a)));
    menu.append(item('Remove every date', 'danger', () => removeEvent(a)));
  } else {
    menu.append(item('Remove', 'danger', () => removeEvent(a)));
  }
  wrap.append(menu);
  // Flip up rather than off the bottom of a 580px-tall popup.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      const box = menu.getBoundingClientRect();
      if (box.bottom > document.documentElement.clientHeight - 4) menu.classList.add('up');
    });
  }
  return wrap;
}

function dueRow(a) {
  const finished = isDone(a);
  const row = el('div', `row${finished ? ' done' : ''}`);
  const top = el('div', 'row-top');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'check';
  box.checked = finished;
  if (a.submitted) {
    // Canvas already knows this one is in; don't pretend it can be un-done here.
    box.disabled = true;
    box.title = 'Submitted on Canvas';
  } else {
    box.title = finished ? 'Mark as not done' : 'Mark as done';
    box.setAttribute('aria-label', box.title);
    box.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(a); });
  }

  const name = el('div', 'name');
  // A hand-added deadline has nowhere to link to.
  if (a.url) name.append(link(a.url, a.name));
  else name.append(document.createTextNode(a.name));
  const due = el('div', `due ${finished ? '' : dueClass(a.dueAt)}`, relative(a.dueAt));
  top.append(box, name, due);
  if (a.manual) top.append(rowMenu(a));

  const meta = el('div', 'meta');
  if (a.manual) meta.append(el('span', 'pill', a.edited ? 'CHANGED' : 'ADDED'));
  else if (a.source === 'gradescope') meta.append(el('span', 'pill', 'GRADESCOPE'));
  const bits = [a.course, shortDate(a.dueAt)].filter(Boolean);
  if (a.repeat) bits.push(`every ${a.repeat}`);
  if (a.points != null) bits.push(`${a.points} pts`);
  if (a.submitted) bits.push('submitted');
  else if (finished) bits.push('done');
  meta.append(document.createTextNode(bits.join('  ·  ')));
  row.append(top, meta);
  return row;
}

// Where "this week" stops. Sunday closes the week, so the next one starts on
// the coming Monday — on a Monday that means today's week runs a full seven
// days, not that the week is already over.
function startOfNextWeek(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d;
}

// What is still to do, split at the week boundaries. Anything overdue sits with
// this week rather than in a band of its own: it is not something to fold away.
function splitByWeek(items) {
  const nextWeek = startOfNextWeek();
  const later = new Date(nextWeek);
  later.setDate(later.getDate() + 7);
  const bands = [
    { key: 'week', label: 'This week', rows: [] },
    { key: 'next', label: 'Next week', rows: [] },
    { key: 'later', label: 'Later', rows: [] },
  ];
  for (const a of items) {
    const due = new Date(a.dueAt);
    bands[due >= later ? 2 : due >= nextWeek ? 1 : 0].rows.push(a);
  }
  return bands;
}

// A folding section. The header is a button so it works from the keyboard.
function group(key, label, rows, emptyText) {
  const wrap = el('div', 'group');
  const open = !state.collapsed[key];

  const head = el('button', `group-head${open ? ' open' : ''}`);
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(el('span', 'chev', '▶'), el('span', 'group-label', label),
    el('span', 'count', String(rows.length)));
  head.addEventListener('click', () => toggleGroup(key));
  wrap.append(head);

  if (open) {
    const body = el('div', 'group-body');
    if (rows.length) rows.forEach((r) => body.append(r));
    else body.append(el('div', 'empty', emptyText));
    wrap.append(body);
  }
  return wrap;
}

function renderDue() {
  const pane = $('due-list');
  pane.textContent = '';
  const items = dueItems();
  const todo = items.filter((a) => !isDone(a));
  const finished = items.filter(isDone);

  // The tab count is what is still outstanding, not the raw total.
  $('due-count').textContent = todo.length || '';

  if (!items.length) {
    pane.append(el('div', 'empty', 'Nothing due in the next 14 days.'));
    return;
  }

  // Each band folds on its own and remembers it. A band with nothing in it is
  // left out entirely rather than drawn as an empty heading.
  if (!todo.length) {
    pane.append(group('todo', 'To do', [], 'Nothing left to do. '));
  } else {
    for (const band of splitByWeek(todo)) {
      if (band.rows.length) pane.append(group(band.key, band.label, band.rows.map(dueRow), ''));
    }
  }
  if (finished.length) {
    pane.append(group('done', 'Done', finished.map(dueRow), ''));
  }
}

async function toggleDone(a) {
  if (state.done[a.id]) delete state.done[a.id];
  else state.done[a.id] = { name: a.name, course: a.course, at: new Date().toISOString() };
  await chrome.storage.local.set({ done: state.done });
  renderDue();
}

async function toggleGroup(key) {
  state.collapsed[key] = !state.collapsed[key];
  await chrome.storage.local.set({ collapsed: state.collapsed });
  renderDue();
}

function annMeta(a) {
  const tags = el('div', 'meta');
  for (const l of (a.labels || []).slice(0, 3)) {
    const cls = l === 'STARRED' ? 'pill p-star'
      : (a.score >= IMPORTANT_THRESHOLD ? 'pill p-hi' : 'pill');
    tags.append(el('span', cls, l));
  }
  tags.append(document.createTextNode(
    `${a.course}  ·  ${a.postedAt ? relative(a.postedAt) : 'unknown'}${a.unread ? '  ·  unread' : ''}`));
  return tags;
}

// Text with the keyword hits bolded. Built as nodes rather than innerHTML —
// this is announcement text from the network, and it is never trusted markup.
function marked(text) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [start, end] of keywordRanges(text)) {
    if (start > at) frag.append(text.slice(at, start));
    frag.append(el('strong', 'kw', text.slice(start, end)));
    at = end;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

function snippetBlock(text) {
  const box = el('div', 'snippet');
  box.append(marked(text), '…');
  return box;
}

function bodyBlock(a) {
  const box = el('div', 'body');
  box.append(marked(a.body || a.snippet || '(no text in this announcement)'));
  if (a.url) {
    box.append(document.createElement('br'));
    const open = link(a.url, 'Open in Canvas ↗');
    open.className = 'open-link';
    box.append(open);
  }
  return box;
}

function renderAnn() {
  const list = $('ann-list');
  list.textContent = '';
  const all = (state.data?.announcements || []).filter((a) => !state.dismissed[a.id]);
  const items = state.importantOnly ? all.filter((a) => a.score >= IMPORTANT_THRESHOLD) : all;
  $('ann-count').textContent = all.length || '';
  if (!items.length) {
    list.append(el('div', 'empty', state.importantOnly
      ? 'No important announcements in the last 14 days.'
      : 'No announcements in the last 14 days.'));
    return;
  }
  for (const a of items) {
    const open = state.expanded.has(a.id);
    const row = el('div', `row ann${open ? ' open' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));

    const top = el('div', 'row-top');
    top.append(el('span', 'chev', '▶'));

    const name = el('div', 'name');
    name.append(link(a.url, a.title));

    const tools = el('div', 'row-tools');
    tools.append(
      iconBtn(`star-btn${state.stars[a.id] ? ' on' : ''}`, state.stars[a.id] ? '★' : '☆',
        state.stars[a.id] ? 'Unstar' : 'Star (always shown as important)', () => toggleStar(a)),
    );

    top.append(name, tools);
    row.append(top, annMeta(a));

    if (open) row.append(bodyBlock(a));
    else if (a.snippet) row.append(snippetBlock(a.snippet));

    // Down in the corner, a line clear of the star: ✕ and ★ side by side meant
    // binning announcements you were only trying to star.
    row.append(iconBtn('x-btn', '✕', 'Move to bin', () => dismiss(a)));

    const toggle = () => {
      if (state.expanded.has(a.id)) state.expanded.delete(a.id);
      else state.expanded.add(a.id);
      renderAnn();
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return; // let stars, X and links do their job
      toggle();
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    list.append(row);
  }
}

function renderBin() {
  const list = $('bin-list');
  list.textContent = '';
  const items = binItems();
  $('empty-bin').disabled = !items.length;
  $('bin-note').textContent = items.length
    ? `${items.length} dismissed announcement${items.length === 1 ? '' : 's'}.`
    : 'Nothing in the bin.';
  if (!items.length) {
    list.append(el('div', 'empty', 'Announcements you dismiss with ✕ land here.'));
    return;
  }
  for (const entry of items) {
    const open = state.expanded.has(`bin:${entry.id}`);
    const row = el('div', `row ann binned${open ? ' open' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));

    const top = el('div', 'row-top');
    top.append(el('span', 'chev', '▶'));

    const name = el('div', 'name');
    name.append(link(entry.url, entry.title));

    top.append(name);
    row.append(top, el('div', 'meta',
      `${entry.course}  ·  dismissed ${entry.at ? relative(entry.at) : 'earlier'}`));

    if (open) row.append(bodyBlock(entry));
    else if (entry.snippet) row.append(snippetBlock(entry.snippet));

    row.append(iconBtn('x-btn', '↩', 'Restore', () => restore(entry)));

    const toggle = () => {
      const key = `bin:${entry.id}`;
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderBin();
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      toggle();
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    list.append(row);
  }
}

function renderHistoryButtons() {
  const u = state.undoStack.at(-1);
  const r = state.redoStack.at(-1);
  $('undo').disabled = !u;
  $('redo').disabled = !r;
  $('undo').title = u ? `Undo ${u.label} (Cmd/Ctrl+Z)` : 'Nothing to undo';
  $('redo').title = r ? `Redo ${r.label} (Cmd/Ctrl+Shift+Z)` : 'Nothing to redo';
  // The buttons are icon-only, so the label has to carry the same detail.
  $('undo').setAttribute('aria-label', $('undo').title);
  $('redo').setAttribute('aria-label', $('redo').title);
}

function render() {
  renderDue();
  renderAnn();
  renderBin();
  renderHistoryButtons();
  if (state.data?.fetchedAt) {
    $('stamp').textContent = `updated ${relative(state.data.fetchedAt)} · ${state.data.courses.length} courses`;
  }
}

async function toggleStar(a) {
  if (state.stars[a.id]) delete state.stars[a.id];
  else state.stars[a.id] = { title: a.title, course: a.course, at: new Date().toISOString() };
  await chrome.storage.local.set({ stars: state.stars });
  // Re-score locally so the change shows without a network round trip.
  const starred = Boolean(state.stars[a.id]);
  a.score += starred ? 1000 : -1000;
  a.labels = a.labels.filter((l) => l !== 'STARRED');
  if (starred) a.labels.unshift('STARRED');
  // Deliberately not re-sorted here. Re-ranking under the cursor yanks the row
  // you just clicked out from under you — and the row you wanted to star next
  // has moved too. The new order is applied when you come back to the tab.
  state.resortAnn = true;
  renderAnn();
  chrome.runtime.sendMessage({ type: 'refreshBadge' }).catch(() => {});
}

function sortAnnouncements() {
  state.data?.announcements.sort((x, y) => y.score - x.score
    || String(y.postedAt || '').localeCompare(String(x.postedAt || '')));
  state.resortAnn = false;
}

async function load({ force } = {}) {
  const cfg = await chrome.storage.local.get(
    ['base', 'token', 'stars', 'cache', 'importantOnly', 'dismissed', 'events', 'undoStack',
      'redoStack', 'done', 'collapsed', 'note', 'gradescopeOn', 'gradescopeCache']);
  state.stars = cfg.stars || {};
  state.importantOnly = Boolean(cfg.importantOnly);
  state.done = cfg.done || {};
  // Only Done starts folded. The week bands are there to be folded away when
  // you want them gone, not to hide work you have not seen yet — a stored
  // choice always wins over the default.
  state.collapsed = { done: true, ...(cfg.collapsed || {}) };
  state.dismissed = cfg.dismissed || {};
  state.events = cfg.events || {};
  state.gradescope = cfg.gradescopeOn ? cfg.gradescopeCache || null : null;
  state.undoStack = cfg.undoStack || [];
  state.redoStack = cfg.redoStack || [];
  pruneEvents();
  $('important-only').checked = state.importantOnly;
  $('note').value = cfg.note || '';
  renderBin();
  renderHistoryButtons();
  // Deadlines typed in here stand on their own — show them even before, or
  // without, a Canvas fetch.
  renderDue();

  if (!cfg.base || !cfg.token) {
    showStatus('Not set up yet.', false, 'Open settings', () => chrome.runtime.openOptionsPage());
    $('due-list').append(el('div', 'empty', 'Add your Canvas URL and access token to get started.'));
    return;
  }

  // Gradescope is independent of Canvas: it has its own session and its own
  // failure modes, so it refreshes alongside rather than inside the Canvas load.
  // It never rejects — it reports its own trouble — so it is safe to await.
  const gradescope = cfg.gradescopeOn ? loadGradescope() : null;

  // Paint the cache immediately, then refresh in the background.
  if (cfg.cache && !force) { state.data = cfg.cache; render(); }

  // Only spin for a refresh the user asked for. On open the popup paints the
  // cache and re-fetches quietly behind it — a spinner there just draws the
  // eye to work nobody asked about.
  if (force) $('refresh').classList.add('spin');
  // With nothing cached there is nothing to paint yet, so say so in the footer
  // rather than sitting blank. Static text, no animation.
  if (!state.data) $('stamp').textContent = 'updating…';
  try {
    const data = await fetchAgenda({ base: cfg.base, token: cfg.token, stars: state.stars });
    state.data = data;
    state.resortAnn = false; // fresh data arrives ranked
    await chrome.storage.local.set({ cache: data });
    hideStatus();
    render();
    chrome.runtime.sendMessage({ type: 'refreshBadge' }).catch(() => {});
  } catch (err) {
    if (err instanceof CanvasError && err.kind === 'auth') {
      showStatus('Canvas rejected the token.', true, 'Fix in settings', () => chrome.runtime.openOptionsPage());
    } else if (err.name === 'TypeError') {
      showStatus('Could not reach Canvas — permission may not be granted for that domain.',
        true, 'Open settings', () => chrome.runtime.openOptionsPage());
    } else {
      showStatus(err.message || 'Something went wrong.', true, 'Retry', () => load({ force: true }));
    }
    if (!state.data) $('due-list').append(el('div', 'empty', 'No cached data to show.'));
  } finally {
    // Keep spinning until both are actually done, or a manual refresh looks
    // finished while Gradescope is still coming in.
    if (gradescope) await gradescope;
    if (force) $('refresh').classList.remove('spin');
  }
}

async function loadGradescope() {
  try {
    const data = await fetchGradescope();
    state.gradescope = data;
    await chrome.storage.local.set({ gradescopeCache: data });
    renderDue();
  } catch (err) {
    // Say so rather than showing a short list as though it were the whole
    // story — a missing deadline is the one failure that actually costs marks.
    const msg = err instanceof GradescopeError ? err.message : 'Could not read Gradescope.';
    showStatus(msg, true, 'Settings', () => chrome.runtime.openOptionsPage());
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const name of ['due', 'ann', 'notes', 'bin']) {
      $(`pane-${name}`).classList.toggle('hidden', tab.dataset.tab !== name);
    }
    // Stars that moved the ranking take effect now, on the way in, rather than
    // rearranging the list while it is being read.
    if (tab.dataset.tab === 'ann' && state.resortAnn) { sortAnnouncements(); renderAnn(); }
    // Land in the note ready to type rather than needing a second click.
    if (tab.dataset.tab === 'notes') $('note').focus();
    else flushNote();
  });
});

$('important-only').addEventListener('change', async (e) => {
  state.importantOnly = e.target.checked;
  await chrome.storage.local.set({ importantOnly: state.importantOnly });
  renderAnn();
});

$('note').addEventListener('input', scheduleNoteSave);
// Nothing is guaranteed to run once the popup starts closing, so write on the
// first sign of it going away instead of waiting for the debounce.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushNote();
});
window.addEventListener('pagehide', flushNote);
window.addEventListener('blur', flushNote);

$('add-event').addEventListener('click', () => openForm($('event-form').classList.contains('hidden')));
$('event-cancel').addEventListener('click', () => openForm(false));
$('event-repeat').addEventListener('change', syncRepeat);
$('event-form').addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
$('scope-one').addEventListener('click', () => applyEdit('one'));
$('scope-all').addEventListener('click', () => applyEdit('all'));
$('scope-cancel').addEventListener('click', () => openForm(false));

// A click anywhere else closes an open ⋯ menu.
document.addEventListener('click', (e) => {
  if (!state.menuFor) return;
  if (e.target instanceof Element && e.target.closest('.menu-wrap')) return;
  state.menuFor = null;
  renderDue();
});
$('event-form').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); openForm(false); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.menuFor) { state.menuFor = null; renderDue(); }
});

$('refresh').addEventListener('click', () => load({ force: true }));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('empty-bin').addEventListener('click', emptyBin);

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
});

load();
