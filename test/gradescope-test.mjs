// Unit tests for gradescope.js. The fixtures below copy the shape of the real
// pages — including the things that are easy to get wrong: a non-ISO datetime,
// two due dates on one row (due, then late due), a header row, old courses
// hidden behind "view inactive", and a row with no due date at all.
//   JSDOM_PATH=<dir with jsdom> node test/gradescope-test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseCourses, parseAssignments, parseStamp, GradescopeError } from '../gradescope.js';

const require = createRequire(path.join(process.env.JSDOM_PATH || '', 'noop.js'));
const { JSDOM } = require('jsdom');
globalThis.DOMParser = new JSDOM().window.DOMParser;

let pass = 0; const fails = [];
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const doc = (html) => new DOMParser().parseFromString(html, 'text/html');

console.log('\n1. Gradescope timestamps are not ISO 8601');
check('the real format parses', parseStamp('2026-09-09 14:10:00 -0700') === '2026-09-09T21:10:00.000Z',
  parseStamp('2026-09-09 14:10:00 -0700'));
check('a positive offset works too',
  parseStamp('2026-01-05 09:30:00 +0530') === '2026-01-05T04:00:00.000Z',
  parseStamp('2026-01-05 09:30:00 +0530'));
check('it agrees with the normalised spelling',
  parseStamp('2026-09-09 14:10:00 -0700') === parseStamp('2026-09-09T14:10:00-07:00'));
check('nothing in, nothing out', parseStamp('') === null && parseStamp(null) === null);
check('junk does not become a date', parseStamp('sometime next week') === null);

const course = (id, short, name) => `
  <a class="courseBox" href="/courses/${id}">
    <h3 class="courseBox--shortname">${short}</h3>
    <div class="courseBox--name">${name}</div>
    <div class="courseBox--assignments">4 assignments</div>
  </a>`;

const dashboard = doc(`<div id="account-show">
  <h2 class="pageHeading">Course Dashboard</h2>
  <div class="courseList">
    <div class="courseList--term">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      ${course(1356155, 'BIO1AL Fa26', '2026 Fall Biology 1AL')}
      ${course(1367911, 'PHYSICS 8B-LEC-002', 'Introductory Physics 8B-002')}
    </div>
    <div class="courseList--term">Spring 2026</div>
    <div class="courseList--coursesForTerm">${course(1205639, 'BIO1A-Sp26', '2026 Spring Biology 1A')}</div>
    <button class="js-viewInactive">View 9 inactive courses</button>
    <div class="courseList--inactiveCourses">
      <div class="courseList--term">Fall 2024</div>
      <div class="courseList--coursesForTerm">${course(835871, 'Data C8', 'Foundations of Data Science')}</div>
    </div>
  </div>
</div>`);

console.log('\n2. the course dashboard');
const courses = parseCourses(dashboard);
check('only the courses still on the dashboard', courses.length === 3,
  courses.map((c) => c.short).join(', '));
check('years of old classes are left behind',
  !courses.some((c) => c.short === 'Data C8'), courses.map((c) => c.short).join(', '));
check('the id comes off the href', courses[0].id === '1356155', courses[0].id);
check('short name and full name both read', courses[0].short === 'BIO1AL Fa26'
  && courses[0].name === '2026 Fall Biology 1AL');
check('each course knows its term', courses[0].term === 'Fall 2026'
  && courses[2].term === 'Spring 2026', courses.map((c) => c.term).join(', '));
try {
  parseCourses(doc('<div>something else entirely</div>'));
  check('a changed layout is an error, not an empty list', false);
} catch (err) {
  check('a changed layout is an error, not an empty list',
    err instanceof GradescopeError && err.kind === 'markup');
}

const table = doc(`<table id="assignments-student-table">
  <thead><tr role="row"><th>Name</th><th>Status</th><th>Released</th></tr></thead>
  <tbody>
    <tr role="row">
      <th><a href="/courses/1356155/assignments/1/submissions/99">Lab 2 Equipment Report</a></th>
      <td><div class="submissionStatus submissionStatus-complete">Submitted</div></td>
      <td><time class="submissionTimeChart--releaseDate" datetime="2026-09-01 12:00:00 -0700"></time>
          <time class="submissionTimeChart--dueDate" datetime="2026-09-09 19:00:00 -0700"></time>
          <time class="submissionTimeChart--dueDate" datetime="2026-09-10 19:00:00 -0700"></time></td>
    </tr>
    <tr role="row">
      <th><button class="js-submitAssignment" data-assignment-id="7">Lab 3 Report</button></th>
      <td><div class="submissionStatus submissionStatus-neutral">No Submission</div></td>
      <td><time class="submissionTimeChart--dueDate" datetime="2026-09-20 23:59:00 -0700"></time></td>
    </tr>
    <tr role="row">
      <th>Extra credit (no deadline)</th>
      <td><div class="submissionStatus submissionStatus-neutral">No Submission</div></td>
      <td></td>
    </tr>
  </tbody>
</table>`);

console.log('\n3. a course assignment table');
const items = parseAssignments(table, { id: '1356155', short: 'BIO1AL Fa26', name: 'Biology 1AL' });
check('the header row is not an assignment', items.length === 2, `got ${items.length}`);
check('one with no due date is skipped',
  !items.some((a) => a.name.includes('Extra credit')), items.map((a) => a.name).join(', '));
check('the name comes off the row heading', items[0].name === 'Lab 2 Equipment Report', items[0].name);
check('the first date is the due date', items[0].dueAt === '2026-09-10T02:00:00.000Z', items[0].dueAt);
check('the second is the late deadline', items[0].lateDueAt === '2026-09-11T02:00:00.000Z',
  items[0].lateDueAt);
check('one due date means no late deadline', items[1].lateDueAt === null);
check('submitted is read from the status class', items[0].submitted === true);
check('and an unsubmitted one is not', items[1].submitted === false);
check('the link is made absolute',
  items[0].url === 'https://www.gradescope.com/courses/1356155/assignments/1/submissions/99',
  items[0].url);
check('a row with no link falls back to the course page',
  items[1].url === 'https://www.gradescope.com/courses/1356155', items[1].url);
check('it is labelled as coming from Gradescope', items.every((a) => a.source === 'gradescope'));
check('the course shown is the short name', items[0].course === 'BIO1AL Fa26');
check('ids are stable and distinct', items[0].id !== items[1].id
  && items[0].id === 'gs:1356155:Lab 2 Equipment Report', items[0].id);

console.log('\n4. a course with no student table is not a failure');
check('it simply has nothing to add',
  parseAssignments(doc('<p>This course has no assignments.</p>'), { id: '1' }).length === 0);

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${fails.length} failed`);
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join('\n'));
process.exit(fails.length ? 1 : 0);
