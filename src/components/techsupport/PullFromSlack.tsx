'use client';

import { RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';

import { pullTicketFromSlack } from '@/app/(app)/tech-support/actions';
import { cn } from '@/lib/cn';

/**
 * Re-read the ticket's Slack thread now. Replies and screenshots arrive on
 * their own (live, plus a sweep every 10 minutes); this is for "I can see a
 * reply in Slack and not here".
 */
export function PullFromSlack({ ticketId }: { ticketId: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setResult(await pullTicketFromSlack(ticketId));
          })
        }
        className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-accent disabled:opacity-60"
      >
        <RefreshCw size={12} className={cn(isPending && 'animate-spin')} />
        {isPending ? 'Syncing…' : 'Sync with Slack'}
      </button>
      {result ? (
        <span className={cn('text-xs', result.ok ? 'text-fg-subtle' : 'text-negative')}>
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
