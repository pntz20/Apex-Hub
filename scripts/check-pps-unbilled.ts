/**
 * The PPS unbilled-show check, on made-up names. Run with `npm run check:pps`.
 */
import { dueMonday, findUnbilled, shortName, similarity, unbilledSlackText } from '../src/lib/billing/pps-unbilled';

let failures = 0;
function check(what: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

check('Wed 9/16 is due Mon 9/21', dueMonday('2026-09-16'), '2026-09-21');
check('Sun 9/20 is due Mon 9/21', dueMonday('2026-09-20'), '2026-09-21');
check('Mon 9/21 is due Mon 9/28', dueMonday('2026-09-21'), '2026-09-28');
check('spelling slip still matches', similarity('Jane Doughty', 'Jane Doughtey') >= 0.5, true);
check('different patient does not', similarity('Jane Doughty', 'Mark Alvarez') < 0.5, true);

const A = 'practice-a';
const shows = [
  { clientId: A, practice: 'Bright Smile', patientName: 'Jane Doughty', appointmentOn: '2026-09-15' },
  { clientId: A, practice: 'Bright Smile', patientName: 'Mark Alvarez', appointmentOn: '2026-09-16' },
  { clientId: A, practice: 'Bright Smile', patientName: 'Lena Ortiz', appointmentOn: '2026-09-17' },
  { clientId: A, practice: 'Bright Smile', patientName: null, appointmentOn: '2026-09-18' },
  { clientId: A, practice: 'Bright Smile', patientName: 'Ray Kim', appointmentOn: '2026-09-29' },
];
const charges = [
  { clientId: A, name: 'Jane Doughtey', occurredOn: '2026-09-21', outcome: 'succeeded' },
  { clientId: A, name: 'Lena Ortiz', occurredOn: '2026-09-21', outcome: 'failed' },
  { clientId: 'practice-b', name: 'Mark Alvarez', occurredOn: '2026-09-21', outcome: 'succeeded' },
];
const rows = findUnbilled(shows, charges, '2026-10-02');
check(
  'charged one skipped, other practice ignored, failed flagged, no-name flagged, not-yet-due skipped',
  rows.map((r) => [r.appointmentOn, r.reason]),
  [['2026-09-16', 'missing'], ['2026-09-17', 'failed'], ['2026-09-18', 'missing']],
);
check('short name', shortName('mark de la cruz'), 'Mark C.');
const text = unbilledSlackText(rows);
check('no full surname in Slack', text.includes('Alvarez'), false);
check('heading', text.split('\n')[0], ':moneybag: *PPS check: 3 shows not charged*');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
