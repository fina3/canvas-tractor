// Repeat rules for hand-added deadlines, and how a rule spells out into dates.
// Pure date arithmetic, kept out of popup.js so it can be tested on its own.

export const DAY = 864e5;

// `days` steps by calendar days rather than by milliseconds, so an 11:59pm
// deadline is still at 11:59pm on the far side of a daylight-saving change.
export const REPEATS = {
  none: { label: 'Once' },
  daily: { label: 'Every day', every: 'day', days: 1 },
  weekly: { label: 'Every week', every: 'week', days: 7 },
  biweekly: { label: 'Every 2 weeks', every: '2 weeks', days: 14 },
  monthly: { label: 'Every month', every: 'month', months: 1 },
};

export const ruleFor = (e) => REPEATS[e.repeat] || REPEATS.none;
export const isRepeating = (e) => Boolean(ruleFor(e).days || ruleFor(e).months);

// Keep the day of the month across a step: the 31st of January has no
// counterpart in February, so land on the last day of the shorter month.
function addMonths(d, n, dayOfMonth) {
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dayOfMonth, lastOfMonth));
}

// The dates of one deadline that land inside [from, to]. A series is stored as
// a single entry with a rule and spelled out here, so "physics homework, weekly"
// stays one thing to remove or undo instead of fifteen rows in storage.
export function* occurrencesOf(e, from, to) {
  const r = ruleFor(e);
  if (!isRepeating(e)) { yield e.at; return; }

  // `until` is a day the user picked, not an instant: it includes that whole day.
  const until = e.until ? new Date(`${e.until}T23:59:59`) : null;
  const stop = until && until < to ? until : to;
  const d = new Date(e.at);
  const dayOfMonth = d.getDate();

  // Jump most of the way rather than walking a year of dates one at a time.
  if (d < from) {
    if (r.days) {
      const jumps = Math.floor((from - d) / (r.days * DAY));
      if (jumps > 0) d.setDate(d.getDate() + jumps * r.days);
    } else {
      const months = (from.getFullYear() - d.getFullYear()) * 12
        + (from.getMonth() - d.getMonth());
      // One short of the mark, so a clamped month can never skip a date.
      if (months > 1) addMonths(d, months - 1, dayOfMonth);
    }
  }
  for (let guard = 0; d <= stop && guard < 200; guard += 1) {
    if (d >= from) yield d.toISOString();
    if (r.days) d.setDate(d.getDate() + r.days);
    else addMonths(d, r.months, dayOfMonth);
  }
}

// Editing one date of a series and choosing "all of them" moves the whole
// series by the same amount, keeping its cadence. Done in calendar terms
// rather than by subtracting milliseconds: a plain ms delta applied across a
// daylight-saving boundary would shift every date by an hour.
export function shiftAnchor(anchorISO, fromISO, toISO) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDelta = Math.round((midnight(to) - midnight(from)) / DAY);
  const anchor = new Date(anchorISO);
  anchor.setDate(anchor.getDate() + dayDelta);
  anchor.setHours(to.getHours(), to.getMinutes(), 0, 0);
  return anchor.toISOString();
}
