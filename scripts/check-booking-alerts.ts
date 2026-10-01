/**
 * The booking alert's text: what it shows, and that it never shows contact
 * details. Run with `npm run check:booking-alerts`.
 */
import { alertText, firstNameLastInitial, formatWhen } from '../src/lib/sync/booking-alerts';

let failures = 0;
function check(what: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

check('first name and last initial', firstNameLastInitial('jane van der berg'), 'Jane B.');
check('one word stays one word', firstNameLastInitial('Cher'), 'Cher');
check('blank is null', firstNameLastInitial('  '), null);
check('time in the practice zone', formatWhen('2026-10-02T14:30:00Z', 'America/Chicago'), 'Fri, Oct 2, 9:30 AM CDT');
check('bad time is null', formatWhen('not a date', 'America/Chicago'), null);

const text = alertText({
  practice: 'Bright Smile',
  bookedBy: 'Karol S',
  patient: 'Jane B.',
  when: 'Fri, Oct 2, 9:30 AM CDT',
  campaign: 'Apex | $3350 for Invisalign',
  deposit: true,
});
check('headline names the agent', text.split('\n')[0], ':tada: *New appointment booked by Karol S!*');
check('six lines', text.split('\n').length, 6);
check('no email, phone or insurance fields', /email|phone|insurance|@|\+1\d{10}/i.test(text), false);
check(
  'unknown agent and deposit are left out, not guessed',
  alertText({ practice: 'Bright Smile', bookedBy: null, patient: null, when: null, campaign: null, deposit: null }),
  ':tada: *New appointment booked!*\n*Practice:* Bright Smile',
);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
