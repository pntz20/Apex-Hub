/**
 * The kick off form mapping, against the form's real question labels
 * (read off form 1SggeGDzW2d72OQ6zYVA, 1 Oct 2026). Answers are made up.
 * Run with `npm run check:kickoff`.
 */
import { kickoffClinicName, kickoffValues } from '../src/lib/onboarding/kickoff';

let failures = 0;
function check(what: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

const answers = {
  'Clinic Name': 'Bright Smile Dental',
  'Clinic Website': 'https://example.com',
  'Doctor Type': 'Dentist',
  'Offer Type': 'Invisalign',
  'Scheduling Type': 'Direct',
  'Promotion Offer/Offers': '$3,000 Invisalign',
  'Sub Offers': ['Free Whitening Kit', 'Free 3D Scans'],
  'Custom Pricing?': 'No',
  'Insurance Specifics: Direct Billing or Fee for Service? (not needed if completed in Doctor Onboarding Form)': 'Direct billing',
  'Insurance Specifics: Remainder amount after insurance application, financeable?': 'Yes',
  'In house financing payment terms. Minimum downpayment amount, Monthly Payment Amounts': '$500 down, $150/mo',
  '3rd party financing terms. Everyone approved? If not: Credit score requirements + Monthly Payment Amounts OAC': 'CareCredit 620+',
  Scheduler: 'Front desk',
  'Office Text Phone Number': '+15555550100',
  'Number of Clinics': '2',
  'Address of Clinic/Clinics': '1 Test St',
  'Daily Ad Budget': '50',
  'Custom Scripting?': '',
};

const { values, unmapped } = kickoffValues(answers);

check('clinic name found', kickoffClinicName(answers), 'Bright Smile Dental');
check('offer type', values['Offer type'], 'Invisalign');
check('promotion goes to Offer Name', values['Offer Name'], '$3,000 Invisalign');
check('multi-select joined', values['Sub offers'], 'Free Whitening Kit, Free 3D Scans');
check('label with a parenthesised note still matches', values['Insurance Specifics: Direct Billing or Fee for Service?'], 'Direct billing');
check('long financing label matches by its start', values['Inhouse Finance'], '$500 down, $150/mo');
check('3rd party financing', values['3rdparty-Finance'], 'CareCredit 620+');
check('two clinics is Multi', values['Multi / Single Location'], 'Multi');
check('address', values['Location Address'], '1 Test St');
check('blank answers are not written', 'Custom Scripting?' in unmapped || Object.values(values).includes(''), false);
check('questions with no custom value are reported, not written', unmapped.sort(), ['Clinic Name', 'Clinic Website', 'Daily Ad Budget']);
check('one clinic is Single', kickoffValues({ 'Number of Clinics': '1' }).values['Multi / Single Location'], 'Single');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
