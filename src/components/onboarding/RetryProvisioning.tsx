'use client';

import { RotateCw } from 'lucide-react';
import { useState, useTransition } from 'react';

import {
  provisionSubmission,
  retryProvisioning,
  type RetryResult,
} from '@/app/(app)/onboarding/provisioning/actions';
import { cn } from '@/lib/cn';

/**
 * Retries one sub-account build.
 *
 * Safe to press twice: if the previous attempt created the account, the retry
 * configures that one rather than making a second. Disabled when the attempt has
 * no submission behind it, because there would be no answers to build from.
 */
export function RetryProvisioning({
  runId,
  submissionId,
  disabled = false,
  needsLocation = false,
}: {
  /** A previous attempt to repeat. Omit for a submission never attempted. */
  runId?: string;
  /** A submission with no attempt yet. */
  submissionId?: string;
  disabled?: boolean;
  /**
   * No sub-account yet: show a box for the location id of the one the tech
   * built by hand from the snapshot (CFT step 22 - the Hub no longer creates
   * them; HighLevel only allows that on Agency Pro).
   */
  needsLocation?: boolean;
}) {
  const [locationId, setLocationId] = useState('');
  const [result, setResult] = useState<RetryResult | null>(null);
  const [pending, startTransition] = useTransition();

  const isFirstAttempt = runId === undefined;

  return (
    <div className="shrink-0 text-right">
      {needsLocation ? (
        <input
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
          placeholder="HighLevel location id or URL"
          aria-label="HighLevel location id of the sub-account built from the snapshot"
          className="mb-1.5 block w-56 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg"
        />
      ) : null}
      <button
        type="button"
        disabled={disabled || pending || (needsLocation && locationId.trim() === '')}
        onClick={() =>
          startTransition(async () => {
            setResult(
              runId !== undefined
                ? await retryProvisioning({ runId, locationId })
                : submissionId !== undefined
                  ? await provisionSubmission({ submissionId, locationId })
                  : {
                      ok: false,
                      message: 'Nothing to build from.',
                    },
            );
          })
        }
        title={
          disabled
            ? 'No submission attached, so there are no answers to rebuild from'
            : isFirstAttempt
              ? 'Build the sub-account from these answers'
              : 'Build again — configures the existing account if one was made'
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
      >
        <RotateCw size={12} className={pending ? 'animate-spin' : undefined} />
        {pending ? 'Setting up…' : needsLocation ? 'Set up' : isFirstAttempt ? 'Provision' : 'Retry'}
      </button>

      {result ? (
        <p
          className={cn(
            'mt-1.5 max-w-xs text-[11px]',
            result.ok ? 'text-positive' : 'text-negative',
          )}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
