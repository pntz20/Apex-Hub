import Link from 'next/link';
import { notFound } from 'next/navigation';

import { resolvePortal } from '@/lib/portal';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'FAQ',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: { token: string };
}

/**
 * Answers to the questions ortho practices ask us most.
 *
 * Source: the "Ortho FAQ for Client Portal" doc linked from the Automation
 * Priority List. Two lines there were for us rather than for the practice and
 * are left out on purpose: where unrefunded deposits go, and the transcription
 * error rate. What the practice needs from each is kept — when a deposit is
 * refunded, and that an agent checks the details and the welcome call
 * confirms them.
 *
 * Static rather than a table. Five answers that change a few times a year are
 * cheaper to edit here than to build an editor for; move them to the database
 * when someone other than an engineer needs to change them.
 *
 * Ortho only. A non-ortho practice reaching this URL gets the same 404 as a
 * wrong page, rather than answers that do not apply to it.
 */
const QUESTIONS: ReadonlyArray<{ q: string; a: string[] }> = [
  {
    q: 'Can you book patients at least 2 days before their appointment?',
    a: [
      'Yes. We regularly book with a 2-day lead time, which gives your team time to verify insurance, go over financials and finalize everything with the patient before they come in.',
      'Ask us and we will book your patients at least 2 days out wherever possible, rather than same day or next day.',
    ],
  },
  {
    q: 'What if a lead books over the weekend or outside business hours?',
    a: [
      'We follow a 2-business-day rule. A patient who books on a Friday or over the weekend is given the nearest Tuesday, so your team has a working day to make the follow-up call before they come in.',
    ],
  },
  {
    q: 'Do your new patient notifications include all patient details, including dental insurance?',
    a: [
      'Every new patient email and text includes the patient’s date of birth and address. Insurance details are included when the patient has them to hand on the call, which is about 30% of the time.',
      'For the rest, your front desk collects insurance on the welcome call they make after our notification arrives. This is the process we walked through on your onboarding call.',
    ],
  },
  {
    q: 'Where do we find the patient’s insurance details, and how do we know they are accurate?',
    a: [
      'They are in the new patient email and text we send for each booking. Details from the call, such as insurance member and group ID, are captured automatically, and our agent reviews them before the notification goes out.',
      'Insurance details are very reliable. Please confirm the address on your welcome call.',
      'We also tell patients which insurance your office accepts, and let patients on other plans know up front that their plan will not cover the cost.',
    ],
  },
  {
    q: 'How does the $25 reservation deposit work?',
    a: [
      'We take and hold the deposit. It is refunded to the patient if they start treatment, or if they ask for it back.',
      'Your front desk can process a refund from your reporting dashboard, as covered at onboarding.',
    ],
  },
];

export default async function PortalFaqPage({ params }: PageProps) {
  const portal = await resolvePortal(params.token);
  if (!portal || !portal.group.isOrtho) notFound();

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-fg">FAQ</h2>
        <p className="mt-0.5 max-w-xl text-sm text-fg-muted">
          Answers to the questions practices ask us most about bookings,
          patient details and deposits.
        </p>
      </div>

      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {QUESTIONS.map((item) => (
          <details key={item.q} className="group px-5 py-4">
            <summary className="cursor-pointer list-none text-sm font-medium text-fg marker:hidden">
              <span className="mr-2 inline-block text-fg-subtle transition-transform group-open:rotate-90">
                ›
              </span>
              {item.q}
            </summary>
            <div className="mt-3 space-y-2 pl-5 text-sm text-fg-muted">
              {item.a.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </details>
        ))}
      </div>

      <p className="mt-6 text-sm text-fg-muted">
        Something not covered here?{' '}
        <Link
          href={`/portal/${params.token}/support`}
          className="font-medium text-accent hover:underline"
        >
          Ask us in Support
        </Link>
        .
      </p>
    </>
  );
}
