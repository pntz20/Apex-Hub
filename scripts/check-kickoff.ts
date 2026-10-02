/**
 * The kick off form mapping, against the form's real question labels
 * (read off form 1SggeGDzW2d72OQ6zYVA, 1 Oct 2026). Answers are made up.
 * Run with `npm run check:kickoff`.
 */
import { kickoffClinicName, kickoffSlackText, kickoffValues, onboardingSlackText } from '../src/lib/onboarding/kickoff';

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

// ---- the #tech-team alert --------------------------------------------------
const alertBase = {
  clinic: 'Bright Smile Dental',
  locationId: 'LOC123',
  written: ['Doctor Type', 'Offer type'],
  missing: [] as string[],
  failed: [] as Array<{ name: string; reason: string }>,
  unmapped: ['Clinic Website'],
  provisioningUrl: 'https://hub.example/onboarding/provisioning',
};
const ok = kickoffSlackText({ ...alertBase, outcome: 'written' });
check('written: handoff-style header', ok.split('\n')[0], ':tada: *Kick Off Form Submitted!*');
check('written: clinic line', ok.includes(':hospital: Clinic: Bright Smile Dental'), true);
check('written: count', ok.includes('Custom values written: 2 of 2'), true);
check('written: no empty lines for missing/refused', /Not in the sub-account|Refused/.test(ok), false);
check('written: answers never appear', ok.includes('Invisalign'), false);
const partial = kickoffSlackText({ ...alertBase, outcome: 'written', missing: ['Scheduler'], failed: [{ name: 'Inhouse Finance', reason: '422' }] });
check('partial: count includes misses', partial.includes('written: 2 of 4'), true);
check('partial: names what to fill by hand', partial.includes('Not in the sub-account: Scheduler') && partial.includes('Refused: Inhouse Finance'), true);
const unmatched = kickoffSlackText({ ...alertBase, outcome: 'unmatched', locationId: null, written: [] });
check('unmatched: warning header', unmatched.startsWith(':warning:'), true);
check('unmatched: links provisioning', unmatched.includes('<https://hub.example/onboarding/provisioning|'), true);
check('unmatched: no sub-account line', unmatched.includes('Sub-account:'), false);

// ---- the onboarding form post ---------------------------------------------
const ob = onboardingSlackText({ clinic: 'Bright Smile Dental', doctor: 'Dr. Test', matched: false, provisioningUrl: 'https://hub.example/onboarding/provisioning' });
check('onboarding: header', ob.split('\n')[0], ':clipboard: *Doctor Onboarding Form Submitted!*');
check('onboarding: new practice line', ob.includes(':new: New practice'), true);
check('onboarding: provisioning link', ob.includes('<https://hub.example/onboarding/provisioning|'), true);
check('onboarding: no doctor line when blank', onboardingSlackText({ clinic: 'X', doctor: ' ', matched: true, provisioningUrl: null }).includes('Doctor:'), false);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
