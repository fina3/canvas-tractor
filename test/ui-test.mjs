// Drives the real popup.html/popup.js/canvas.js in jsdom against the mock
// Canvas API in mocks.js, and asserts the expand / bin / undo / redo behaviour.
// Run:  JSDOM_PATH=<dir with jsdom installed> node test/ui-test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.JSDOM_PATH || '', 'noop.js'));
const { JSDOM } = require('jsdom');

const html = readFileSync(path.join(here, '..', 'popup.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://popup.test/', runScripts: 'outside-only' });
const { window } = dom;

for (const k of ['document', 'location', 'DOMParser', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'HTMLElement', 'getComputedStyle']) {
  globalThis[k] = window[k];
}
globalThis.window = window;

await import('./mocks.js');

// Watch the refresh icon from before the popup starts, so the test can tell
// whether it ever span during the initial load.
const refreshEl = window.document.getElementById('refresh');
let spunOnOpen = false;
let spunOnClick = false;
let watchClick = false;
new window.MutationObserver(() => {
  if (!refreshEl.classList.contains('spin')) return;
  if (watchClick) spunOnClick = true;
  else spunOnOpen = true;
}).observe(refreshEl, { attributes: true, attributeFilter: ['class'] });

await import('../popup.js');

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const tick = () => new Promise((r) => setTimeout(r, 0));
// Always wait on the rendered DOM rather than on globalThis.__store: a commit
// persists before it re-renders, so a store watch wakes one tick early and the
// assertions that follow read the previous render.
async function until(fn, what, tries = 200) {
  for (let i = 0; i < tries; i += 1) { if (fn()) return; await tick(); }
  throw new Error(`timed out waiting for: ${what}`);
}

let pass = 0; const fails = [];
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const binSize = () => $$('#bin-list .row').length;
// The ⋯ menu rebuilds the list when it opens, so the row has to be found again
// by position rather than held onto across the click.
async function openMenu(row) {
  const i = $$('#pane-due .row').indexOf(row);
  $$('#pane-due .row')[i].querySelector('.menu-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  return $$('#pane-due .row')[i];
}
const menuLabels = (row) => [...row.querySelectorAll('.menu-item')].map((b) => b.textContent);
async function clickMenu(row, label) {
  const r = await openMenu(row);
  const item = [...r.querySelectorAll('.menu-item')].find((b) => b.textContent.includes(label));
  if (!item) throw new Error(`no menu item "${label}" in [${menuLabels(r).join(', ')}]`);
  item.click();
  await new Promise((r2) => setTimeout(r2, 0));
}
const rowByTitle = (sel, t) => $$(sel).find((r) => r.querySelector('.name').textContent.includes(t));
const titles = (sel) => $$(sel).map((r) => r.querySelector('.name').textContent);

await until(() => $$('#ann-list .row').length > 0, 'first render');

console.log('\n1. initial render');
// The 4th is submitted, so it sits under the collapsed Done section.
check('3 outstanding assignments shown in Due', $$('#pane-due .row').length === 3,
  `got ${$$('#pane-due .row').length}`);
check('6 announcements listed', $$('#ann-list .row.ann').length === 6);
// pinned RESCHEDULED+unread (95+30+5) outranks the unpinned cancellation (100+5)
check('highest-scoring announcement is first', titles('#ann-list .row.ann')[0].includes('Midterm 2'));
check('cancellation is second', titles('#ann-list .row.ann')[1].includes('Lecture cancelled'));
check('low-scoring logistics sinks to the bottom',
  titles('#ann-list .row.ann').at(-1).includes('Guest lecture'));
check('collapsed row shows a truncated snippet',
  $$('#ann-list .row.ann')[1].querySelector('.snippet').textContent.length < 240);
check('undo disabled at start', $('#undo').disabled === true);
check('redo disabled at start', $('#redo').disabled === true);
check('bin empty at start', binSize() === 0);
check('the Bin tab is just a label, with no count',
  $('.tab[data-tab="bin"]').textContent.trim() === 'Bin',
  JSON.stringify($('.tab[data-tab="bin"]').textContent));
check('empty-bin disabled', $('#empty-bin').disabled === true);

console.log('\n1b. To do / Done sections');
const heads = () => $$('#pane-due .group-head').map((h) => h.querySelector('.group-label').textContent);
const groupHead = (label) => $$('#pane-due .group-head')
  .find((h) => h.querySelector('.group-label').textContent === label);
// Everything still outstanding, whichever week band it landed in — which band
// that is depends on what day the suite runs, so assertions must not care.
const todoHeads = () => $$('#pane-due .group-head')
  .filter((h) => h.querySelector('.group-label').textContent !== 'Done');
const todoRows = () => todoHeads().flatMap((h) => [...h.parentElement
  .querySelectorAll('.group-body .row')]);
const groupRows = (label) => {
  const head = groupHead(label);
  const body = head && head.parentElement.querySelector('.group-body');
  return body ? [...body.querySelectorAll('.row')] : [];
};
const rowNames = (label) => groupRows(label).map((r) => r.querySelector('.name').textContent);
const todoNames = () => todoRows().map((r) => r.querySelector('.name').textContent);

check('week sections, then Done', heads().at(-1) === 'Done'
  && heads().slice(0, -1).every((h) => ['This week', 'Next week', 'Later'].includes(h)),
  heads().join('|'));
check('3 unfinished assignments still to do', todoRows().length === 3,
  todoNames().join(' | '));
check('the submitted one starts under Done', groupRows('Done').length === 0
  || rowNames('Done')[0].includes('Homework 9'));
check('Done starts collapsed', groupHead('Done').getAttribute('aria-expanded') === 'false');
check('the outstanding work is split into week sections',
  todoHeads().every((h) => ['This week', 'Next week', 'Later']
    .includes(h.querySelector('.group-label').textContent)), heads().join(', '));
check('tab count shows what is outstanding, not the total',
  $('#due-count').textContent === '3', $('#due-count').textContent);

groupHead('Done').click();
await tick();
check('clicking the header expands Done', groupRows('Done').length === 1);
check('submitted item is checked', groupRows('Done')[0].querySelector('.check').checked === true);
check('submitted item cannot be un-ticked here',
  groupRows('Done')[0].querySelector('.check').disabled === true);
check('submitted item is struck through', groupRows('Done')[0].classList.contains('done'));

console.log('\n1c. ticking an assignment off');
const target = todoRows().find((r) => r.querySelector('.name').textContent.includes('Lab 7'));
check('to-do items have an enabled checkbox', target.querySelector('.check').disabled === false);
target.querySelector('.check').click();
await until(() => groupRows('Done').length === 2, 'moved to Done');
check('moved out of the week sections', !todoNames().some((n) => n.includes('Lab 7')));
check('now under Done', rowNames('Done').some((n) => n.includes('Lab 7')));
check('count dropped to 2', $('#due-count').textContent === '2');
check('persisted', Object.keys(globalThis.__store.done || {}).length === 1);

const back = groupRows('Done').find((r) => r.querySelector('.name').textContent.includes('Lab 7'));
back.querySelector('.check').click();
await until(() => todoRows().length === 3, 'moved back');
check('un-ticking returns it to its week', todoNames().some((n) => n.includes('Lab 7')));
check('storage cleared', Object.keys(globalThis.__store.done || {}).length === 0);

// Fold whichever band happens to hold the nearest work today.
const firstBand = todoHeads()[0].querySelector('.group-label').textContent;
const bandSize = groupRows(firstBand).length;
todoHeads()[0].click();
await tick();
check(`${firstBand} folds away too`, groupRows(firstBand).length === 0);
const bandKey = { 'This week': 'week', 'Next week': 'next', Later: 'later' }[firstBand];
check('collapsed state persisted', globalThis.__store.collapsed[bandKey] === true,
  JSON.stringify(globalThis.__store.collapsed));
groupHead(firstBand).click();
await tick();
check('and unfolds again', groupRows(firstBand).length === bandSize);
check('each section remembers its own state independently',
  groupHead('Done').getAttribute('aria-expanded') === 'true'
  && groupHead(firstBand).getAttribute('aria-expanded') === 'true');

console.log('\n2. the refresh icon');
check('does not spin on open', spunOnOpen === false);
check('not left spinning', !refreshEl.classList.contains('spin'));
watchClick = true;
refreshEl.click();
await until(() => spunOnClick, 'manual refresh spins');
check('does spin when the button is clicked', spunOnClick === true);
await until(() => !refreshEl.classList.contains('spin'), 'spin stops');
check('stops when the refresh finishes', !refreshEl.classList.contains('spin'));

console.log('\n3. tabs');
$('.tab[data-tab="ann"]').click();
check('announcements pane shown', !$('#pane-ann').classList.contains('hidden'));
check('due pane hidden', $('#pane-due').classList.contains('hidden'));
check('notes pane hidden', $('#pane-notes').classList.contains('hidden'));

console.log('\n3b. notes');
check('there is a Notes tab', !!$('.tab[data-tab="notes"]'));
check('the saved note is loaded',
  $('#note').value === 'ask about the regrade window in office hours', $('#note').value);
$('.tab[data-tab="notes"]').click();
await tick();
check('notes pane shown', !$('#pane-notes').classList.contains('hidden'));
check('announcements pane hidden now', $('#pane-ann').classList.contains('hidden'));
check('focus lands in the note', window.document.activeElement === $('#note'));

$('#note').value = 'midterm 2 moved to Dwinelle 155\nbring a blue book';
$('#note').dispatchEvent(new window.Event('input', { bubbles: true }));
check('says it is saving', $('#note-status').textContent === 'Saving…', $('#note-status').textContent);
await until(() => globalThis.__store.note.includes('Dwinelle'), 'note autosaved', 2000);
check('autosaved to storage', globalThis.__store.note.includes('bring a blue book'));
check('says it saved', $('#note-status').textContent === 'Saved', $('#note-status').textContent);

// The popup dies as soon as it loses focus, so a pending write must be flushed.
$('#note').value = 'and pick up the lab report';
$('#note').dispatchEvent(new window.Event('input', { bubbles: true }));
check('write is still pending', !globalThis.__store.note.includes('lab report'));
window.document.dispatchEvent(new window.Event('visibilitychange'));
Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
window.document.dispatchEvent(new window.Event('visibilitychange'));
await until(() => globalThis.__store.note.includes('lab report'), 'flushed on hide', 2000);
check('pending note flushed when the popup goes away',
  globalThis.__store.note === 'and pick up the lab report');

$('.tab[data-tab="ann"]').click();
await tick();
check('switching back to Announcements works', !$('#pane-ann').classList.contains('hidden'));

console.log('\n4. click to expand');
const row = rowByTitle('#ann-list .row.ann', 'Lecture cancelled');
check('starts collapsed', !row.classList.contains('open') && !!row.querySelector('.snippet'));
row.click();
await tick();
const opened = rowByTitle('#ann-list .row.ann', 'Lecture cancelled');
check('row is open', opened.classList.contains('open'));
check('aria-expanded set', opened.getAttribute('aria-expanded') === 'true');
check('snippet replaced by full body', !opened.querySelector('.snippet') && !!opened.querySelector('.body'));
check('body holds text beyond the 220-char snippet',
  opened.querySelector('.body').textContent.includes('Office hours still run'),
  opened.querySelector('.body').textContent.slice(0, 80));
check('body has Open in Canvas link', !!opened.querySelector('.body a.open-link'));
check('paragraphs are separated, not welded together',
  /cancelled\.\s+I am out sick/.test(opened.querySelector('.body').textContent),
  JSON.stringify(opened.querySelector('.body').textContent.slice(0, 70)));
check('paragraph break preserved as a newline',
  opened.querySelector('.body').textContent.includes('\n'));
check('snippet stays a single visual line',
  !$$('#ann-list .row.ann .snippet')[0].textContent.startsWith('\n'));
check('html entities decoded', opened.querySelector('.body').textContent.includes('Thursday’s'));

const kws = [...opened.querySelectorAll('.body .kw')].map((k) => k.textContent.toLowerCase());
check('keyword "cancelled" is bolded', kws.includes('cancelled'), kws.join('|'));
check('body text is unchanged by bolding',
  opened.querySelector('.body').textContent.includes('Thursday’s lecture is cancelled.'));
check('no markup injected — bold is a real element',
  opened.querySelector('.body .kw').tagName === 'STRONG');
const midtermKw = [...rowByTitle('#ann-list .row.ann', 'Midterm 2')
  .querySelectorAll('.snippet .kw')].map((k) => k.textContent.toLowerCase());
check('"midterm" bolded in a collapsed snippet too', midtermKw.includes('midterm'), midtermKw.join('|'));
check('"blue book" bolded', midtermKw.includes('blue book'), midtermKw.join('|'));
const projKw = [...rowByTitle('#ann-list .row.ann', 'Project 2 deadline')
  .querySelectorAll('.snippet .kw')].map((k) => k.textContent.toLowerCase());
check('"project" bolded (asked for, not a scoring rule)', projKw.includes('project'), projKw.join('|'));
check('"deadline" bolded', projKw.includes('deadline'), projKw.join('|'));
const logistics = rowByTitle('#ann-list .row.ann', 'Office hours moved');
check('low-signal words are not bolded',
  ![...logistics.querySelectorAll('.snippet .kw')].some((k) => /office hours|slides/i.test(k.textContent)),
  [...logistics.querySelectorAll('.snippet .kw')].map((k) => k.textContent).join('|'));
opened.click();
await tick();
check('click again collapses',
  !rowByTitle('#ann-list .row.ann', 'Lecture cancelled').classList.contains('open'));

console.log('\n5. clicking the title link does not toggle');
const linkRow = rowByTitle('#ann-list .row.ann', 'Midterm 2');
linkRow.querySelector('.name a').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick();
check('row stayed collapsed',
  !rowByTitle('#ann-list .row.ann', 'Midterm 2').classList.contains('open'));

console.log('\n6. X moves to bin');
rowByTitle('#ann-list .row.ann', 'Midterm 2').querySelector('.x-btn').click();
await until(() => $$('#ann-list .row.ann').length === 5, 'row removed');
check('gone from announcements', !rowByTitle('#ann-list .row.ann', 'Midterm 2'));
check('announcements count now 5', $('#ann-count').textContent === '5');
check('one item in the bin', binSize() === 1);
check('bin row rendered', !!rowByTitle('#bin-list .row', 'Midterm 2'));
check('bin row has restore', !!rowByTitle('#bin-list .row', 'Midterm 2').querySelector('.x-btn'));
check('undo now enabled', $('#undo').disabled === false);
check('undo tooltip names the action', /dismissed "Midterm 2 room change"/.test($('#undo').title),
  $('#undo').title);
check('persisted to storage', Object.keys(globalThis.__store.dismissed || {}).length === 1);
check('badge refresh requested', globalThis.__sent.some((m) => m.type === 'refreshBadge'));

console.log('\n7. bin rows expand too');
const binRow = rowByTitle('#bin-list .row', 'Midterm 2');
binRow.click();
await tick();
check('bin row expands', rowByTitle('#bin-list .row', 'Midterm 2').classList.contains('open'));
check('bin row shows full body',
  rowByTitle('#bin-list .row', 'Midterm 2').querySelector('.body').textContent.includes('blue book'));

console.log('\n8. undo / redo');
$('#undo').click();
await until(() => $$('#ann-list .row.ann').length === 6, 'undo restores');
check('back in announcements', !!rowByTitle('#ann-list .row.ann', 'Midterm 2'));
check('bin empty again', binSize() === 0);
check('undo disabled again', $('#undo').disabled === true);
check('redo enabled', $('#redo').disabled === false);
check('storage cleared', Object.keys(globalThis.__store.dismissed || {}).length === 0);
$('#redo').click();
await until(() => $$('#ann-list .row.ann').length === 5, 'redo re-bins');
check('re-binned', !!rowByTitle('#bin-list .row', 'Midterm 2'));
check('undo enabled again', $('#undo').disabled === false);

console.log('\n9. keyboard shortcuts');
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'z', metaKey: true, bubbles: true }));
await until(() => $$('#ann-list .row.ann').length === 6, 'cmd+z undoes');
check('cmd+z undid the dismiss', !!rowByTitle('#ann-list .row.ann', 'Midterm 2'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
await until(() => $$('#ann-list .row.ann').length === 5, 'cmd+shift+z redoes');
check('cmd+shift+z redid it', !!rowByTitle('#bin-list .row', 'Midterm 2'));

console.log('\n10. empty bin, and undoing it');
rowByTitle('#ann-list .row.ann', 'Guest lecture').querySelector('.x-btn').click();
await until(() => binSize() === 2, 'second dismiss');
check('two in bin', binSize() === 2);
check('empty-bin enabled', $('#empty-bin').disabled === false);
$('#empty-bin').click();
await until(() => binSize() === 0, 'bin emptied');
check('bin shows nothing', $$('#bin-list .row').length === 0);
check('emptied items did not come back to announcements',
  $$('#ann-list .row.ann').length === 4, `got ${$$('#ann-list .row.ann').length}`);
check('tombstones kept, without the body text',
  Object.values(globalThis.__store.dismissed).every((e) => e.purged && !e.body));
$('#undo').click();
await until(() => binSize() === 2, 'empty-bin undone');
check('one undo restored both items to the bin', $$('#bin-list .row').length === 2);
check('restored entries have their body back',
  Object.values(globalThis.__store.dismissed).every((e) => !e.purged && e.body));
check('announcements still 4', $$('#ann-list .row.ann').length === 4);

console.log('\n11. new action clears the redo stack');
$('#undo').click();                       // undo the "Guest lecture" dismiss
await until(() => $('#redo').disabled === false, 'redo available');
rowByTitle('#ann-list .row.ann', 'Project 2 deadline').querySelector('.x-btn').click();
await until(() => !!rowByTitle('#bin-list .row', 'Project 2 deadline'), 'new dismiss');
check('redo disabled after a fresh action', $('#redo').disabled === true);

console.log('\n12. important-only filter still works with the bin');
$('#important-only').checked = true;
$('#important-only').dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
const shown = $$('#ann-list .row.ann').length;
check('filter narrows the list', shown > 0 && shown < 5, `showing ${shown}`);
check('binned items stay out under the filter', !rowByTitle('#ann-list .row.ann', 'Project 2 deadline'));

console.log('\n13. hand-added deadlines');
const binBefore = binSize();
$('.tab[data-tab="due"]').click();
await tick();
check('the form starts hidden', $('#event-form').classList.contains('hidden'));
$('#add-event').click();
await tick();
check('clicking + opens the form', !$('#event-form').classList.contains('hidden'));
check('aria-expanded set on the button', $('#add-event').getAttribute('aria-expanded') === 'true');
check('when is prefilled with an 11:59pm', /T23:59$/.test($('#event-when').value), $('#event-when').value);
check('focus lands in the title', window.document.activeElement === $('#event-title'));

// Nameless: refuses and says why rather than adding a blank row.
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
check('a nameless deadline is refused', $('#event-error').textContent.length > 0,
  $('#event-error').textContent);
check('nothing was added', Object.keys(globalThis.__store.events || {}).length === 0);

const soon = new Date(Date.now() + 30 * 36e5);
const pad = (n) => String(n).padStart(2, '0');
const local = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`
  + `T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
$('#event-title').value = 'Lab report 3 (Gradescope)';
$('#event-course').value = 'CHEM 1A';
$('#event-when').value = local;
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await until(() => !!rowByTitle('#pane-due .row', 'Lab report 3'), 'event added to the list');

check('form closes after adding', $('#event-form').classList.contains('hidden'));
check('it is persisted', Object.keys(globalThis.__store.events).length === 1);
check('stored as an instant, not wall-clock',
  Object.values(globalThis.__store.events)[0].at === soon.toISOString().replace(/:\d\d\.\d+Z$/, ':00.000Z'),
  Object.values(globalThis.__store.events)[0].at);

const evtRow = rowByTitle('#pane-due .row', 'Lab report 3');
check('marked as added by hand', evtRow.querySelector('.pill').textContent === 'ADDED');
check('the course shows', evtRow.querySelector('.meta').textContent.includes('CHEM 1A'));
check('no filler where the course would be', !evtRow.querySelector('.meta').textContent
  .includes('Added by you'));
check('no dead link on the title', !evtRow.querySelector('.name a'));
check('it has a ⋯ menu', !!evtRow.querySelector('.menu-btn'));
check('the outstanding count includes it', $('#due-count').textContent === '4',
  $('#due-count').textContent);

// Sorted in among the Canvas assignments by time, not appended to the end.
const order = todoNames();
check('sorted into the To do list by due time',
  order.indexOf(order.find((n) => n.includes('Lab report 3'))) === 2, order.join(' | '));

// Ticking it off behaves like any other row.
evtRow.querySelector('.check').click();
await until(() => groupRows('Done').some((r) => r.querySelector('.name').textContent.includes('Lab report 3')),
  'event moved to Done');
check('a hand-added deadline can be ticked off', $('#due-count').textContent === '3');
rowByTitle('#pane-due .row', 'Lab report 3').querySelector('.check').click();
await until(() => $('#due-count').textContent === '4', 'untick');

console.log('\n14. adding and removing are undoable');
$('#undo').click();
await until(() => !rowByTitle('#pane-due .row', 'Lab report 3'), 'add undone');
check('Cmd+Z reaches the deadline, not the bin', !rowByTitle('#pane-due .row', 'Lab report 3'));
check('and it is gone from storage', Object.keys(globalThis.__store.events).length === 0);
$('#redo').click();
await until(() => !!rowByTitle('#pane-due .row', 'Lab report 3'), 'add redone');
check('redo puts it back', Object.keys(globalThis.__store.events).length === 1);

await clickMenu(rowByTitle('#pane-due .row', 'Lab report 3'), 'Remove');
await until(() => !rowByTitle('#pane-due .row', 'Lab report 3'), 'event removed');
check('⋯ → Remove removes it', Object.keys(globalThis.__store.events).length === 0);
$('#undo').click();
await until(() => !!rowByTitle('#pane-due .row', 'Lab report 3'), 'removal undone');
check('removal is undoable too', Object.keys(globalThis.__store.events).length === 1);
check('the bin was left alone throughout', binSize() === binBefore,
  `bin has ${binSize()}, started at ${binBefore}`);

console.log('\n15. a repeating deadline');
const pad2 = (n) => String(n).padStart(2, '0');
const localAt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

$('#add-event').click();
await tick();
check('the end date is hidden while it is a one-off',
  $('#event-until-wrap').classList.contains('hidden'));
$('#event-repeat').value = 'weekly';
$('#event-repeat').dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
check('choosing a repeat reveals the end date',
  !$('#event-until-wrap').classList.contains('hidden'));

// An end date before the first date is a typo, not a series.
const day3 = new Date(Date.now() + 3 * 24 * 36e5);
$('#event-title').value = 'Physics homework';
$('#event-when').value = localAt(day3);
$('#event-until').value = '2020-01-01';
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
check('an end date before the start is refused', $('#event-error').textContent.includes('before'),
  $('#event-error').textContent);

$('#event-until').value = '';
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await until(() => !!rowByTitle('#pane-due .row', 'Physics homework'), 'weekly deadline added');

// Held by id, not by title: the edit tests below rename it.
const physId = Object.values(globalThis.__store.events)
  .find((e) => e.title === 'Physics homework').id;
const weeklyRows = () => [globalThis.__store.events[physId]].filter(Boolean);
check('stored as one entry with a rule, not one row per week',
  weeklyRows().length === 1 && weeklyRows()[0].repeat === 'weekly',
  JSON.stringify(weeklyRows()));

const physics = () => $$('#pane-due .row')
  .filter((r) => r.querySelector('.name').textContent.includes('Physics'));
// 14 days of horizon from a first date 3 days out: this week's and next week's.
check('two dates inside the 14-day view', physics().length === 2, `got ${physics().length}`);
check('they are a week apart', (() => {
  const [a, b] = physics().map((r) => r.querySelector('.due').textContent);
  return a !== b;
})());
check('each says how often it repeats',
  physics()[0].querySelector('.meta').textContent.includes('every week'),
  physics()[0].querySelector('.meta').textContent);

console.log('\n16. each date is ticked off on its own');
const before = $('#due-count').textContent;
physics()[0].querySelector('.check').click();
await until(() => groupRows('Done').some((r) => r.querySelector('.name').textContent.includes('Physics')),
  'first date done');
check('ticking one moves only that one', todoRows()
  .filter((r) => r.querySelector('.name').textContent.includes('Physics')).length === 1);
check('next week is untouched', groupRows('Done')
  .filter((r) => r.querySelector('.name').textContent.includes('Physics')).length === 1);
check('the count drops by exactly one',
  Number($('#due-count').textContent) === Number(before) - 1,
  `${before} -> ${$('#due-count').textContent}`);
check('ticks are keyed by date, not by the series',
  Object.keys(globalThis.__store.done).some((k) => k.startsWith('evt:') && k.includes('@')),
  Object.keys(globalThis.__store.done).join(','));

console.log('\n17. removing a series takes every date with it');
await clickMenu(rowByTitle('#pane-due .row', 'Physics homework'), 'Remove every date');
await until(() => physics().length === 0, 'series removed');
check('all its dates go', physics().length === 0);
check('the entry is gone', weeklyRows().length === 0);
$('#undo').click();
await until(() => physics().length === 2, 'series restored');
check('one undo brings the whole series back', physics().length === 2);
check('and the tick on the first date survived', groupRows('Done')
  .filter((r) => r.querySelector('.name').textContent.includes('Physics')).length === 1);

console.log('\n18. the ⋯ menu');
const first = () => physics()[0];
const second = () => physics()[1];
const repeatMenu = menuLabels(await openMenu(first()));
check('a repeating date offers edit, cancel-from-here and remove',
  repeatMenu.join('|') === 'Edit…|Cancel this and every later one|Remove every date',
  repeatMenu.join('|'));
check('the menu is on screen', $$('#pane-due .menu').length === 1);
window.document.body.click();               // a click elsewhere closes it
await tick();
check('clicking away closes the menu', $$('#pane-due .menu').length === 0);

const onceMenu = menuLabels(await openMenu(rowByTitle('#pane-due .row', 'Lab report 3')));
check('a one-off has nothing to say about repeats',
  onceMenu.join('|') === 'Edit…|Remove', onceMenu.join('|'));
window.document.body.click();
await tick();

console.log('\n19. editing one date, or every date');
await clickMenu(first(), 'Edit…');
check('the form opens filled in', $('#event-title').value === 'Physics homework'
  && $('#event-repeat').value === 'weekly', $('#event-title').value);
check('and the menu closes behind it', $$('#pane-due .menu').length === 0);
check('the button says Save, not Add', $('#event-save').textContent === 'Save');

$('#event-title').value = 'Physics homework (short one)';
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
check('editing a repeating date asks which', !$('#event-scope').classList.contains('hidden'));
check('and hides the ordinary buttons', $('#event-foot').classList.contains('hidden'));

$('#scope-one').click();
await until(() => physics()[0].querySelector('.name').textContent.includes('short one'), 'this one changed');
check('only this date took the new name',
  !physics()[1].querySelector('.name').textContent.includes('short one'),
  physics()[1].querySelector('.name').textContent);
check('the changed date is marked',
  physics()[0].querySelector('.pill').textContent === 'CHANGED');
check('the series itself is untouched', weeklyRows()[0].title === 'Physics homework');
check('stored as one carved-out date', Object.keys(weeklyRows()[0].overrides).length === 1);

// Now the same edit, applied to the whole series.
await clickMenu(second(), 'Edit…');
$('#event-title').value = 'Physics problem set';
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
$('#scope-all').click();
await until(() => physics().length === 2
  && physics().every((r) => r.querySelector('.name').textContent.includes('problem set')),
'series renamed');
check('every date takes the new name',
  physics().every((r) => r.querySelector('.name').textContent.includes('Physics problem set')),
  physics().map((r) => r.querySelector('.name').textContent).join(' | '));
check('and it supersedes the single date carved out earlier',
  Object.keys(weeklyRows()[0].overrides).length === 0);
check('the cadence is kept', weeklyRows()[0].repeat === 'weekly');

console.log('\n20. moving a date keeps the clock, and the series keeps its rhythm');
const anchorBefore = weeklyRows()[0].at;
const whenBefore = first().querySelector('.meta').textContent;
await clickMenu(first(), 'Edit…');
const moved = new Date($('#event-when').value);
moved.setDate(moved.getDate() + 1);          // one day later, same time
$('#event-when').value = localAt(moved);
$('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
$('#scope-all').click();
await until(() => physics().length === 2
  && first().querySelector('.meta').textContent !== whenBefore, 'series moved');
check('the whole series shifted by a day',
  Math.round((new Date(weeklyRows()[0].at) - new Date(anchorBefore)) / 36e5) === 24,
  `${anchorBefore} -> ${weeklyRows()[0].at}`);
check('still two dates, still a week apart', physics().length === 2);
check('the time of day survived',
  new Date(weeklyRows()[0].at).getHours() === moved.getHours());

console.log('\n21. cancelling this one and every later one');
const keptDate = second().querySelector('.meta').textContent;
await clickMenu(second(), 'Cancel this and every later one');
await until(() => physics().length === 1, 'later dates cancelled');
check('the later date goes', physics().length === 1);
check('the earlier one stays', !physics()[0].querySelector('.meta').textContent.includes(keptDate));
check('the series is bounded, not deleted', weeklyRows().length === 1 && !!weeklyRows()[0].until,
  JSON.stringify(weeklyRows()[0]));
$('#undo').click();
await until(() => physics().length === 2, 'uncancelled');
check('undo brings the later dates back', physics().length === 2);

console.log('\n22. starring does not rearrange the list under you');
$('.tab[data-tab="ann"]').click();
await tick();
$('#important-only').checked = false;
$('#important-only').dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
const annOrder = () => titles('#ann-list .row.ann');
const beforeStar = annOrder();
const last = $$('#ann-list .row.ann').at(-1);
const lastTitle = last.querySelector('.name').textContent;
last.querySelector('.star-btn').click();
await until(() => globalThis.__store.stars && Object.keys(globalThis.__store.stars).length > 0,
  'star saved');
check('the star is saved straight away', Object.keys(globalThis.__store.stars).length === 1);
check('it shows as starred', $$('#ann-list .row.ann').at(-1).querySelector('.star-btn')
  .classList.contains('on'));
check('but the row has not jumped', annOrder().join('|') === beforeStar.join('|'),
  annOrder().join(' | '));

$('.tab[data-tab="due"]').click();
await tick();
$('.tab[data-tab="ann"]').click();
await tick();
check('it moves to the top on the way back in', annOrder()[0] === lastTitle,
  `${annOrder()[0]} vs ${lastTitle}`);
check('and it is flagged STARRED',
  $$('#ann-list .row.ann')[0].querySelector('.pill').textContent === 'STARRED');

console.log('\n23. the week sections');
$('.tab[data-tab="due"]').click();
await tick();
// Anchored to the real boundary the code uses, so this holds whatever day the
// suite runs on: the week turns over at Monday 00:00.
const monday = new Date();
monday.setHours(0, 0, 0, 0);
monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
const addAt = (title, when) => {
  $('#add-event').click();
  $('#event-title').value = title;
  $('#event-when').value = localAt(when);
  $('#event-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
};
addAt('Just after the turn', new Date(monday.getTime() + 36e5));
await until(() => !!rowByTitle('#pane-due .row', 'Just after the turn'), 'next-week item added');
addAt('Week after that', new Date(monday.getTime() + 8 * 24 * 36e5));
await until(() => !!rowByTitle('#pane-due .row', 'Week after that'), 'later item added');

check('a Next week section appears', !!groupHead('Next week'), heads().join('|'));
check('and a Later one', !!groupHead('Later'), heads().join('|'));
check('sections run in time order, Done last',
  heads().join('|').endsWith('Next week|Later|Done'), heads().join('|'));
check('the Monday item is in Next week',
  rowNames('Next week').some((n) => n.includes('Just after the turn')),
  rowNames('Next week').join(' | '));
check('the week-after item is in Later',
  rowNames('Later').some((n) => n.includes('Week after that')), rowNames('Later').join(' | '));
check('each section counts its own',
  groupHead('Later').querySelector('.count').textContent === String(groupRows('Later').length));
check('nothing starts hidden',
  todoHeads().every((h) => h.getAttribute('aria-expanded') === 'true'), heads().join('|'));

console.log('\n24. folding one week away');
const laterCount = groupRows('Later').length;
const nextCount = groupRows('Next week').length;
groupHead('Later').click();
await tick();
check('Later folds', groupRows('Later').length === 0);
check('Next week is untouched', groupRows('Next week').length === nextCount);
check('the row is gone from the list, not from the count',
  !rowByTitle('#pane-due .row', 'Week after that')
  && groupHead('Later').querySelector('.count').textContent === String(laterCount));
check('the tab count still includes what is folded away',
  Number($('#due-count').textContent) > todoRows().length,
  `${$('#due-count').textContent} vs ${todoRows().length} shown`);
check('the fold is remembered', globalThis.__store.collapsed.later === true,
  JSON.stringify(globalThis.__store.collapsed));
groupHead('Later').click();
await tick();
check('and it opens again', groupRows('Later').length === laterCount);

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${fails.length} failed`);
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join('\n'));
process.exit(fails.length ? 1 : 0);
