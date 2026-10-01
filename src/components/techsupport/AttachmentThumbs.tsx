'use client';

import { FileText } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { Attachment } from '@/lib/tickets/attachments';

/**
 * Small previews of a ticket's or a comment's files.
 *
 * Used where a full gallery would be too much: under a comment, and in the
 * ticket row on the Tech Support list, so a screenshot is visible without
 * opening anything. Click opens the full image in a new tab. Same plain <img>
 * reasoning as TicketAttachments: the URLs are signed and expire.
 */
export function AttachmentThumbs({
  attachments,
  size = 'md',
  max = 6,
  className,
}: {
  attachments: readonly Attachment[];
  size?: 'sm' | 'md';
  max?: number;
  className?: string;
}) {
  if (attachments.length === 0) return null;

  const shown = attachments.slice(0, max);
  const more = attachments.length - shown.length;
  const box = size === 'sm' ? 'h-12 w-16' : 'h-28 w-40';

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {shown.map((item) =>
        item.url && item.mimeType.startsWith('image/') ? (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noreferrer"
            title={item.fileName}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'block overflow-hidden rounded-md border border-line bg-surface-sunken hover:border-accent',
              box,
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt={item.fileName} className="h-full w-full object-cover" />
          </a>
        ) : item.url ? (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <FileText size={12} />
            {item.fileName}
          </a>
        ) : (
          <span key={item.id} className="text-xs text-fg-subtle">
            {item.fileName} (reload to view)
          </span>
        ),
      )}
      {more > 0 ? <span className="text-xs text-fg-subtle">+{more} more</span> : null}
    </div>
  );
}
