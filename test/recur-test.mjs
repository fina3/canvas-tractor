// Unit tests for recur.js — the dates a repeat rule spells out. No DOM, no
// mocks: these are the cases the jsdom UI test cannot reach, because they turn
// on specific calendar dates (month ends, daylight saving) rather than on
// whatever today happens to be.
//   node test/recur-test.mjs
import { occurrencesOf, shiftAnchor } from '../recur.js';

let pass = 0; const fails = [];
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Local wall-clock time, the way the datetime-local input hands it over.
// Window bounds below always carry a time: a bare "2026-10-02" is parsed as
// UTC midnight by JS, which is the previous evening in most of the US and
// would quietly move the edge of the window.
const at = (s) => new Date(s).toISOString();
const dates = (e, from, to) => [...occurrencesOf(e, new Date(from), new Date(to))];
// What a human would read off the clock, to show DST shifts if there are any.
const local = (iso) => new Date(iso).toLocaleString('en-US', { hour12: false });
const clock = (iso) => local(iso).split(', ')[1];

console.log('\n1. a one-off is just itself');
const once = { at: at('2026-09-10T23:59'), repeat: 'none' };
check('yields one date', dates(once, '2026-09-01T00:00', '2026-12-01T00:00').length === 1);
check('and yields it even from outside the window',
  dates(once, '2030-01-01T00:00', '2030-02-01T00:00').length === 1);

console.log('\n2. weekly');
const weekly = { at: at('2026-09-10T23:59'), repeat: 'weekly' };
const wk = dates(weekly, '2026-09-01T00:00', '2026-10-02T00:00');
check('every 7 days', wk.length === 4, `got ${wk.length}`);
check('starts on the date given', wk[0] === at('2026-09-10T23:59'));
check('lands on the same weekday each time',
  new Set(wk.map((d) => new Date(d).getDay())).size === 1);
check('nothing before the window',
  dates(weekly, '2026-09-11T00:00', '2026-09-18T00:00').length === 1);

console.log('\n3. the clock does not drift across daylight saving');
// US DST ended 2026-11-01. Stepping in milliseconds would move an 11:59pm
// deadline to 10:59pm for the rest of the term.
const overDst = dates({ at: at('2026-10-20T23:59'), repeat: 'weekly' },
  '2026-10-01T00:00', '2026-11-20T00:00');
check('spans the change', overDst.length >= 4, `got ${overDst.length}`);
check('still 23:59 on every date', new Set(overDst.map(clock)).size === 1,
  overDst.map(local).join(' | '));

console.log('\n4. monthly, including short months');
// The 31st: February has no counterpart, so it clamps rather than sliding into March.
const eom = dates({ at: at('2027-01-31T23:59'), repeat: 'monthly' },
  '2027-01-01T00:00', '2027-05-01T00:00');
const days = eom.map((d) => new Date(d).getDate());
check('one date a month', eom.length === 4, `got ${eom.length}`);
check('February clamps to the 28th', days[1] === 28, `got ${days[1]}`);
check('and it does not slip into March', new Date(eom[1]).getMonth() === 1);
check('March goes back to the 31st, not the 28th', days[2] === 31, `got ${days[2]}`);
check('the clock is unchanged', new Set(eom.map(clock)).size === 1, eom.map(local).join(' | '));

console.log('\n5. an end date stops it');
const bounded = { at: at('2026-09-10T23:59'), repeat: 'weekly', until: '2026-10-01' };
const bd = dates(bounded, '2026-09-01T00:00', '2026-12-01T00:00');
check('stops at the end date', bd.length === 4, `got ${bd.length}`);
check('nothing past it', new Date(bd.at(-1)) <= new Date('2026-10-01T23:59:59'));
check('the end date itself is included, all day',
  dates({ ...bounded, until: '2026-09-24' }, '2026-09-01T00:00', '2026-12-01T00:00').length === 3);

console.log('\n6. a series started long ago is cheap and correct');
const old = { at: at('2020-09-10T23:59'), repeat: 'daily' };
const t0 = Date.now();
const recent = dates(old, '2026-09-09T00:00', '2026-09-16T00:00');
check('fast-forwards instead of walking 6 years', Date.now() - t0 < 50);
check('one a day across the window', recent.length === 7, `got ${recent.length}`);
check('first is the first 23:59 inside the window',
  local(recent[0]).startsWith('9/9/2026'), local(recent[0]));
check('still 23:59 six years on', new Set(recent.map(clock)).size === 1);

console.log('\n7. runaway rules are capped, not infinite');
check('a daily rule over a decade stops at the guard',
  dates({ at: at('2026-01-01T09:00'), repeat: 'daily' },
    '2026-01-01T00:00', '2036-01-01T00:00').length === 200);

console.log('\n8. moving a whole series by editing one of its dates');
// Anchor Sep 10; the user drags the Sep 24 date to Sep 25. Every date moves a
// day, and the series keeps its weekly rhythm.
const moved = shiftAnchor(at('2026-09-10T23:59'), at('2026-09-24T23:59'), at('2026-09-25T23:59'));
check('the anchor moves by the same one day', local(moved).startsWith('9/11/2026'), local(moved));
check('the time of day is untouched', clock(moved) === '23:59:00', clock(moved));
const after = dates({ at: moved, repeat: 'weekly' }, '2026-09-01T00:00', '2026-10-10T00:00');
check('the cadence survives', new Set(after.map((d) => new Date(d).getDay())).size === 1);
check('and the edited date is one of them',
  after.some((d) => local(d).startsWith('9/25/2026')), after.map(local).join(' | '));

// Changing only the time of day moves no dates.
const retimed = shiftAnchor(at('2026-09-10T23:59'), at('2026-09-24T23:59'), at('2026-09-24T17:00'));
check('a time-only change keeps the date', local(retimed).startsWith('9/10/2026'), local(retimed));
check('and takes the new time', clock(retimed) === '17:00:00', clock(retimed));

// The trap: subtracting milliseconds across the 2026-11-01 change would land
// the anchor an hour off and leave every later date wrong too.
const overChange = shiftAnchor(at('2026-10-15T23:59'), at('2026-11-05T23:59'), at('2026-11-06T23:59'));
check('a shift across a daylight-saving change keeps the clock',
  clock(overChange) === '23:59:00', local(overChange));
check('and still moves exactly one day', local(overChange).startsWith('10/16/2026'),
  local(overChange));

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${fails.length} failed`);
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join('\n'));
process.exit(fails.length ? 1 : 0);
