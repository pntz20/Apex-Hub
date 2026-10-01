/*
 * Two-way sync between a ticket's comments and its Slack thread.
 *
 * Until now a ticket raised from Slack kept only the first message's text.
 * Replies in the thread (usually tech answering) never reached the Hub, and a
 * screenshot on the original message was never copied, so the Tech Support tab
 * showed a ticket with 0 comments and 0 attachments while the thread held both.
 *
 * Every Slack message and file carries its own id. Storing it makes each import
 * idempotent: Slack's retries, the app_mention and message events both firing
 * for one reply, and the reconcile cron re-reading a thread all land on the
 * same row instead of writing a second one.
 */

alter table public.tech_ticket_comments
  add column if not exists source text not null default 'hub'
    check (source in ('hub', 'slack')),
  /*
   * For a Slack reply: that reply's ts. For a Hub comment: the ts of the copy
   * the bot posted into the thread, or null when it could not post.
   */
  add column if not exists slack_message_ts text;

create unique index if not exists tech_ticket_comments_slack_ts_uidx
  on public.tech_ticket_comments (ticket_id, slack_message_ts)
  where slack_message_ts is not null;

alter table public.tech_ticket_attachments
  /* Slack's file id (F…) when the file came from, or was sent to, the thread. */
  add column if not exists slack_file_id text;

create unique index if not exists tech_ticket_attachments_slack_file_uidx
  on public.tech_ticket_attachments (ticket_id, slack_file_id)
  where slack_file_id is not null;

comment on column public.tech_ticket_comments.source is
  'hub = written on the Hub (mirrored into Slack); slack = a reply in the ticket''s Slack thread.';
comment on column public.tech_ticket_attachments.slack_file_id is
  'Slack file id. Set for files copied from the thread and for Hub uploads sent to it; unique per ticket so a re-import is a no-op.';
