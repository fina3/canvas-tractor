# Canvas Agenda — Chrome extension

Click the toolbar icon to see what's due and which announcements actually matter.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder (`~/canvas-extension`)
4. Click the extension icon → gear → fill in:
   - **Canvas URL** — where you log in, e.g. `https://bcourses.berkeley.edu`
   - **Access token** — Canvas → Account → Settings → *Approved Integrations* →
     **+ New Access Token**
5. Hit **Grant access & save**. Chrome asks permission for that one domain; the extension
   ships with no host access until you grant it.

Pin the extension (puzzle-piece icon → pin) so it stays visible.

## What it shows

**Due tab** — assignments with a due date in the next 14 days, soonest first, split into folding
sections: **This week**, **Next week**, **Later** and **Done**. Tick an assignment's checkbox to
move it to Done, untick it to bring it back. Anything Canvas already reports as submitted starts
in Done with its checkbox ticked and disabled — Canvas is the authority on that one, so it can't
be un-done here. Click a section header to fold it; each remembers its own state. The count on the
tab is what's still outstanding, not the raw total.

Ticks are stored locally in `chrome.storage.local` (Canvas has no per-student "done" flag for an
assignment you haven't submitted), so they're per-browser and not visible to your instructor.

The split happens at the week boundaries, so what is due before the weekend is separate from what
can wait, and each week folds away on its own. The week ends Sunday, so the next one starts on the
coming Monday. A section only appears if something actually falls in it, and anything overdue
stays under **This week** rather than getting a band of its own: it is not something to fold away.

Only **Done** starts folded. The week sections are there to be put away when you want them gone,
not to hide work you haven't seen — and the tab count covers everything outstanding, including
whatever is folded out of sight.

**+ Add a deadline** — not everything with a due date lives in Canvas: a lab report handed in
through Gradescope, an exam announced out loud in lecture. Type a name, a date and time, and
optionally a course, and it joins the same list in chronological order, marked **ADDED**. Tick it
off like anything else. The time picker starts at the next 11:59pm, so the usual case is a title
and Enter; Esc closes the form.

**⋯** on any added row opens **Edit…** and **Remove**. Editing reopens the same form, filled in.

**Repeats.** Physics homework every Friday, a quiz every other week: pick *Every day*, *Every
week*, *Every 2 weeks* or *Every month* instead of *Once*, and optionally an **until** date for
when the term ends. Each date is a row of its own that you tick off separately — ticking this
week's says nothing about next week's — but the series is stored as **one entry with a rule**, so
**✕** removes the whole thing (every date, undoable in one step) and there is one thing to edit
rather than fifteen.

Two details the rules get right: a repeat steps by *calendar* days, so an 11:59pm deadline is
still 11:59pm after the clocks change; and *Every month* from the 31st clamps to the 28th in
February rather than sliding into March, then goes back to the 31st.

**Editing one date of a series** is ambiguous — this Friday, or every Friday? — so saving asks
rather than guessing:

> Change just this one, or all of them?  **[ Just this one ]  [ All of them ]**

*Just this one* carves that date out of the series and leaves the rule alone; the row is then
marked **CHANGED** instead of ADDED. *All of them* moves the whole series by however far this date
moved, so it keeps its rhythm — drag one Friday to Saturday and every date follows — and it
supersedes any single dates carved out earlier. A one-off has only one answer, so it just saves.

**⋯ → Cancel this and every later one** ends the series here: this date and everything after it
go, everything already behind you stays, so a class that stops meeting doesn't erase the term's
record. **Remove every date** deletes the series outright. Both are one undo away.

A repeating deadline is spelled out only as far ahead as the list looks — the same 14 days Canvas
is fetched for, plus a day of grace so one you have just missed is still in front of you. A
**one-off** is different: it shows whenever it falls, beyond the horizon or long overdue, until
you tick or remove it, because you named that exact date on purpose. Ticked-off one-offs are
cleared 14 days after their date.

Added deadlines are yours alone — they live in `chrome.storage.local` and are never written back
to Canvas.

**Announcements tab** — the last 14 days, ranked by importance. "Important only" filters to
score ≥ 75. **Click a row to expand it** and read the full announcement text inline (no second
fetch — the body is cached with the rest of the agenda); click again to collapse. **✕** sits in
the bottom-right corner of a row, a line clear of the ☆ in the top-right — side by side they made
it easy to bin an announcement you were only trying to star.

**Notes tab** — a plain scratchpad that lives in the popup: reading to catch up on, what to ask
in office hours, an exam date you don't want to lose. It saves as you type (200ms after you stop)
and is flushed again the moment the popup starts closing, since a popup is torn down as soon as it
loses focus. Switching to the tab puts the cursor straight in the note. The text is kept in
`chrome.storage.local`, so it stays in this browser profile and goes nowhere near Canvas.

**Bin tab** — hit **✕** on any announcement to move it to the bin. Binned announcements drop
out of the Announcements list and out of the badge count, but nothing is lost: the Bin tab lists
them with **↩ Restore**, and rows there expand the same way. **Empty bin** clears them all
(itself undoable). Each binned item keeps its own copy of the title, course and body, so the bin
still reads correctly after the announcement ages out of Canvas's 14-day window.

| Score | Category | Catches |
|------:|----------|---------|
| 100 | CANCELLED | cancelled, no class, not meeting |
| 95 | RESCHEDULED | rescheduled, postponed, room/location change, new time |
| 90 | EXAM | exam, midterm, final, quiz, proctor, study guide |
| 85 | DEADLINE | deadline, due date, extended, late policy, grace period |
| 75 | URGENT | urgent, important, please read, ASAP, reminder |
| 60 | GRADES | grades, regrade, scores posted, rubric, curve |
| 40 | LOGISTICS | office hours, zoom link, slides posted, recording |

A keyword in the **title** scores full; body-only scores 60%. Pinned adds 30, unread adds 5.

## Gradescope

Some courses hand work in through Gradescope, which Canvas never hears about. Turn on **Also show
upcoming Gradescope deadlines** in settings and grant access to `gradescope.com`, and anything due
in the next 14 days joins the same list, marked **GRADESCOPE**.

There is no password to enter and no API key: Gradescope has no public API and no calendar feed,
so this reads the same pages you do, using the session you are already signed into. The fetches go
to gradescope.com and the results stay in this browser.

That also means it depends on the layout of Gradescope's pages, which is theirs to change without
notice. So the parsing is deliberately loud — if the dashboard stops looking like a dashboard, the
popup says it could not read Gradescope rather than quietly showing you an empty list, because a
deadline that silently goes missing is the one failure that actually costs marks. Courses
Gradescope has filed away under "view inactive" are skipped, and a single unreadable course is
dropped rather than sinking the rest.

`gradescope.js` has no dependency on the popup and can be read on its own; `test/gradescope-test.mjs`
exercises it against fixtures copied from real pages — a non-ISO `datetime`, two due dates on one
row (due, then late), a header row, hidden old courses, and a row with no deadline at all.

## Starring

Canvas has no star/important flag on announcements — the only per-user state a student can set
is read/unread. So stars are kept locally in `chrome.storage.local`. Click ☆ on any announcement
to pin it to the top permanently (+1000). Manage them from the settings page.

The star saves immediately, but the list is **not** re-ranked under your cursor — the row you just
clicked would jump out from under you, taking the next one you meant to click with it. The new
order is applied the next time you come into the tab.

## Undo / redo

↶ and ↷ in the header undo and redo bin actions — dismiss, restore, and empty-bin alike — plus
adding and removing a hand-added deadline.
**Cmd/Ctrl+Z** and **Cmd/Ctrl+Shift+Z** (or Ctrl+Y) do the same. The history holds the last 50
actions and is stored in `chrome.storage.local`, so it survives closing the popup; hovering a
button tells you which action it will undo or redo.

## Badge

The toolbar icon shows a count of unread important announcements, refreshed on a background
alarm (default 30 min; Chrome's floor is 15). Binned announcements are excluded from the count.
Turn it off in settings.

## Notes

- The token is stored in `chrome.storage.local` — this browser profile only, not synced, and
  sent nowhere but your own Canvas server.
- The popup paints cached data instantly, then refreshes in the background.
- If one course errors (restricted, concluded), its assignments are skipped rather than
  failing the whole popup.
- Some institutions disable self-generated tokens. If **+ New Access Token** is missing from
  your Canvas settings page, you'd need an OAuth2 app instead.

## Tests

`test/` runs the real `popup.html` / `popup.js` / `canvas.js` in jsdom against a mock Canvas
API and clicks through expand, dismiss, restore, empty-bin, starring, adding, repeating, editing,
cancelling and removing a deadline, the folding week sections, undo/redo and the keyboard
shortcuts — 181 assertions:

```
npm install jsdom            # anywhere; note the directory
JSDOM_PATH=<that dir> node test/ui-test.mjs
```

`test/recur-test.mjs` tests `recur.js` on its own — no DOM, no jsdom, nothing to install. These
are the cases the UI test can't reach, because they turn on particular calendar dates rather than
on whatever today happens to be: month-end clamping, the clock holding across a daylight-saving
change, `until` bounds, moving a whole series, and a series started years ago. 29 assertions, and
worth running under a few zones:

```
node test/recur-test.mjs
TZ=Australia/Sydney node test/recur-test.mjs
```

`test/gradescope-test.mjs` parses fixture pages — it needs jsdom for `DOMParser`, but never the
network and never your account. 25 assertions:

```
JSDOM_PATH=<that dir> node test/gradescope-test.mjs
```

`test/harness.html` is generated from `popup.html` so it cannot drift from the real popup —
regenerate it with `node test/build-harness.mjs` after editing `popup.html`. It loads the same
mocks in a browser, for eyeballing the UI without installing the extension:

```
python3 -m http.server 8731   # then open localhost:8731/test/harness.html
```

Add `#ann`, `#ann,open`, `#notes`, `#done` or `#bin` to the URL to land on a given state.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest; optional host permissions, granted per-domain at setup |
| `canvas.js` | API client (pagination, batching) + scoring rules — shared |
| `recur.js` | Repeat rules, the dates they spell out, and moving a series — pure, no DOM |
| `gradescope.js` | Reads gradescope.com with your own session; parsing + typed errors |
| `popup.html/css/js` | The click-to-open panel: due / announcements / notes / bin tabs |
| `options.html/css/js` | Setup, badge settings, star management, rule reference |
| `background.js` | Alarm-driven polling and badge count |
| `test/` | jsdom interaction test, `recur.js` unit test, browser harness, mock Canvas API |

A CLI version with the same scoring lives at `~/canvas_agenda.py`.
