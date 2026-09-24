'use client';

import { X } from 'lucide-react';
import { useState, useTransition } from 'react';

import {
  addClientAdAccount,
  removeClientAdAccount,
  type MapResult,
} from '@/app/(app)/settings/ad-accounts/actions';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

export interface AccountOption {
  id: string;
  name: string | null;
  spendCents: number;
  /** The practice already owning its spend, if any. */
  takenBy: string | null;
}

export interface OwnedAccount {
  accountId: string;
  accountName: string | null;
}

/**
 * One row's accounts.
 *
 * A practice can own several accounts' spend (client_ad_accounts), so this
 * shows each owned account with a remove button, plus a picker to add one.
 * Saves on change: there are 60-odd practices to work through. The result is
 * shown inline so a refusal is attached to the row it concerns.
 */
export function AdAccountPicker({
  clientId,
  owned,
  options,
}: {
  clientId: string;
  owned: OwnedAccount[];
  options: AccountOption[];
}) {
  const [result, setResult] = useState<MapResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const ownedIds = new Set(owned.map((account) => account.accountId));
  const nameById = new Map(options.map((option) => [option.id, option.name]));

  return (
    <span className="flex flex-col items-end gap-1.5">
      {owned.length > 0 ? (
        <span className="flex flex-wrap justify-end gap-1.5">
          {owned.map((account) => (
            <span
              key={account.accountId}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-sunken px-2 py-0.5 text-xs text-fg"
            >
              {account.accountName ?? nameById.get(account.accountId) ?? account.accountId}
              <button
                type="button"
                disabled={isPending}
                aria-label={`Remove ${account.accountId}`}
                className="text-fg-subtle hover:text-negative disabled:opacity-50"
                onClick={() =>
                  startTransition(async () => {
                    setResult(
                      await removeClientAdAccount({
                        clientId,
                        accountId: account.accountId,
                      }),
                    );
                  })
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </span>
      ) : null}

      <select
        value=""
        disabled={isPending}
        onChange={(event) => {
          const next = event.target.value;
          if (next === '') return;
          startTransition(async () => {
            setResult(
              await addClientAdAccount({
                clientId,
                accountId: next,
                accountName: nameById.get(next) ?? null,
              }),
            );
          });
        }}
        className={cn(
          'h-9 w-64 rounded-md border bg-surface-sunken px-2 text-xs text-fg',
          result && !result.ok ? 'border-negative' : 'border-line',
          isPending && 'opacity-60',
        )}
        aria-label="Add a Windsor ad account"
      >
        <option value="">{owned.length > 0 ? 'Add another account' : 'Not mapped: add account'}</option>
        {options
          .filter((option) => !ownedIds.has(option.id))
          .map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={option.takenBy !== null}
            >
              {option.name ?? option.id}
              {option.spendCents > 0
                ? ` · ${formatMoney(option.spendCents)}`
                : ' · no spend'}
              {option.takenBy !== null ? ` — ${option.takenBy}` : ''}
            </option>
          ))}
      </select>

      {result ? (
        <span
          className={cn(
            'text-[11px]',
            result.ok ? 'text-positive' : 'text-negative',
          )}
        >
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
