/**
 * The PPS pre-charge check, on made-up names. Run with `npm run check:pps-precharge`.
 */
import {
  isBillingField,
  judge,
  loadedNames,
  matchPractice,
  prechargeSlackText,
  slotLabel,
  type Appt,
} from '../src/lib/billing/pps-precharge';

let failures = 0;
function check(what: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

check('billing field', isBillingField('GD - Lead Name For Billing 10'), true);
check('hybrid billing field', isBillingField('Hybrid - Lead Name For Billing 2'), true);
check('other field', isBillingField('Date of birth'), false);
check('slot label GD', slotLabel('GD - Lead Name For Billing 3'), 'GD slot 3');
check('slot label standard', slotLabel('Lead Name For Billing 7'), 'slot 7');

const fields = new Map([
  ['f1', 'Lead Name For Billing 1'],
  ['f2', 'Lead Name For Billing 2'],
  ['f10', 'Lead Name For Billing 10'],
]);
check(
  'loaded names skip blanks and other fields, slot order',
  loadedNames(
    [
      { id: 'f10', value: 'Lena Ortiz' },
      { id: 'f2', value: '  ' },
      { id: 'f1', value: 'Jane Doughty' },
      { id: 'other', value: 'x' },
    ],
    fields,
  ).map((n) => n.name),
  ['Jane Doughty', 'Lena Ortiz'],
);

const now = new Date('2026-10-04T22:00:00Z'); // a Sunday
const appts: Appt[] = [
  { clientId: 'c', patientName: 'Jane Doughty', scheduledAt: '2026-09-30T16:00:00Z', status: 'showed' },
  { clientId: 'c', patientName: 'Mark Alvarez', scheduledAt: '2026-10-16T16:00:00Z', status: 'confirmed' },
  { clientId: 'c', patientName: 'Lena Ortiz', scheduledAt: '2026-10-01T16:00:00Z', status: 'no_show' },
  { clientId: 'c', patientName: 'Ray Kim', scheduledAt: '2026-10-01T16:00:00Z', status: 'cancelled' },
  { clientId: 'c', patientName: 'Ana Silva', scheduledAt: '2026-09-29T16:00:00Z', status: 'confirmed' },
  { clientId: 'c', patientName: 'Tom Reyes', scheduledAt: '2026-09-29T16:00:00Z', status: 'confirmed' },
  { clientId: 'c', patientName: 'Tom Reyes', scheduledAt: '2026-10-20T16:00:00Z', status: 'confirmed' },
];
check('showed is fine (spelling slip)', judge('Jane Doughtey', appts, now).verdict, 'ok');
check('moved to a future date is flagged', judge('Mark Alvarez', appts, now), { verdict: 'future', on: '2026-10-16' });
check('no-show is flagged', judge('Lena Ortiz', appts, now).verdict, 'no_show');
check('cancelled is flagged', judge('Ray Kim', appts, now).verdict, 'cancelled');
check('past and unmarked is the 3-day rule, fine', judge('Ana Silva', appts, now).verdict, 'ok');
check('unmarked past plus a future one is flagged', judge('Tom Reyes', appts, now).verdict, 'future');
check('unknown name is flagged', judge('Zed Nobody', appts, now).verdict, 'not_found');

const practices = [
  { key: 'mesa', names: ['Great Smiles of La Mesa'] },
  { key: 'andros', names: ['Andros Orthodontics'] },
  { key: 'tmj-g', names: ['TMJ Sleep Airway Orthodontics - Gainesville'] },
  { key: 'tmj-w', names: ['TMJ Sleep Airway Orthodontics - Williston'] },
  { key: 'art', names: ['Art Of Smile: Center for Cosmetic Orthodontics'] },
  { key: 'td-n', names: ['Team Dental N. Liberties'] },
  { key: 'td-s', names: ['Team Dental Swedesboro'] },
];
check('exact name', matchPractice('Great Smiles of La Mesa', practices), ['mesa']);
check('short name inside the long one', matchPractice('Art of Smile', practices), ['art']);
check('Airway is the TMJ locations, never Andros', matchPractice('Airway Orthodontics', practices), ['tmj-g', 'tmj-w']);
check('Team Dental is both Team Dentals', matchPractice('Team Dental', practices), ['td-n', 'td-s']);
check('unrelated name matches nothing', matchPractice('Firewheel Smiles', practices), []);

const text = prechargeSlackText(
  [{ practice: 'Bright Smile', slot: 'Lead Name For Billing 2', name: 'Mark Alvarez', verdict: 'future', on: '2026-10-16' }],
  12,
  5,
  [],
);
check('no full surname in Slack', text.includes('Alvarez'), false);
check('line names the slot and the reason', text.includes('Mark A. · slot 2 · appointment is still ahead (10/16)'), true);
check('all clear', prechargeSlackText([], 12, 5, []).startsWith(':white_check_mark:'), true);
check('nothing read is a warning, not an all clear', prechargeSlackText([], 0, 0, []).startsWith(':warning:'), true);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
