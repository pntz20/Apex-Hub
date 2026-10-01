/**
 * Slack → Hub half of the ticket thread sync.
 *
 * A ticket raised from Slack used to keep only the first message's words.
 * Whatever happened next in the thread (tech's answer, the screenshot, the
 * "fixed, thanks") stayed in Slack, so tech had to keep both open to know where
 * a ticket stood. This copies the thread into the ticket:
 *
 *   - files on the message that raised the ticket → ticket attachments
 *   - every human reply in the thread → a comment (source 'slack'), with its
 *     files attached to that comment
 *
 * The Hub → Slack half lives in tech-support/actions.ts (comments and uploads
 * are posted into the thread by the bot).
 *
 * LOOPS. Anything the bot posts (the "Filed as…" reply, Hub comments mirrored
 * into the thread, Hub uploads) is a bot message and is skipped here, so a Hub
 * comment never comes back as a second, Slack-sourced copy of itself.
 *
 * IDEMPOTENT. Comments are keyed on (ticket, Slack ts) and files on
 * (ticket, Slack file id), both unique in migration 0104. The live event, a
 * Slack retry and the reconcile cron can all see the same reply; one row wins.
 */
import {
  botUserId as fetchBotUserId,
  downloadSlackFile,
  lookupUser,
  threadMessages,
  type SlackFile,
  type SlackThreadMessage,
} from '@/lib/slack/api';
import { ALLOWED_TYPES, MAX_BYTES, attachToTicket } from '@/lib/tickets/attachments';
import { serviceClient } from '@/lib/supabase/service';

const UNIQUE_VIOLATION = '23505';

/** Reply subtypes that are a person talking. Joins, bot posts, edits are not. */
const HUMAN_SUBTYPES = new Set<string | null>([null, 'file_share', 'thread_broadcast']);

export function isHumanReply(message: {
  botId: string | null;
  subtype: string | null;
  user: string | null;
}): boolean {
  return !message.botId && message.user !== null && HUMAN_SUBTYPES.has(message.subtype);
}

/**
 * Slack's markup, made readable outside Slack.
 *
 * <@U123> → @Name (from `names`, else the id), <#C1|general> → #general,
 * <https://x|label> → label (https://x), <!here> → @here, and the three HTML
 * entities Slack escapes.
 */
export function slackTextToPlain(
  text: string,
  names: Readonly<Record<string, string>> = {},
): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) =>
      `@${names[id] ?? label ?? id}`,
    )
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_, name: string) => `#${name}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, word: string) => `@${word}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? '@group')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url: string) => url)
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, (_, label: string) => label)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Slack people, looked up once per run. */
export type People = Map<string, { name: string; hubUserId: string | null; isBot: boolean }>;

async function person(people: People, slackId: string) {
  const known = people.get(slackId);
  if (known) return known;

  const user = await lookupUser(slackId);
  let hubUserId: string | null = null;

  if (user?.email) {
    const found = await serviceClient()
      .from('user_profiles')
      .select('id')
      .ilike('email', user.email)
      .maybeSingle();
    hubUserId = found.data?.id ?? null;
  }

  const entry = { name: user?.name ?? slackId, hubUserId, isBot: user?.isBot === true };
  people.set(slackId, entry);
  return entry;
}

async function namesIn(people: People, text: string): Promise<Record<string, string>> {
  const ids = [
    ...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((match) => match[1] as string)),
  ].slice(0, 5);
  const names: Record<string, string> = {};
  for (const id of ids) names[id] = (await person(people, id)).name;
  return names;
}

export interface FileImport {
  imported: number;
  alreadyHere: number;
  /** Not an image/PDF, over 10 MB, or Slack would not hand over the bytes. */
  skipped: number;
}

/** Copy Slack files onto a ticket (and a comment, when given). */
export async function importSlackFiles(input: {
  ticketId: string;
  commentId?: string | null;
  files: readonly SlackFile[];
  uploadedByName: string | null;
  uploadedBy?: string | null;
}): Promise<FileImport> {
  const result: FileImport = { imported: 0, alreadyHere: 0, skipped: 0 };

  for (const file of input.files) {
    if (!ALLOWED_TYPES.includes(file.mimetype) || file.size > MAX_BYTES) {
      result.skipped += 1;
      continue;
    }

    const downloaded = await downloadSlackFile(file);
    if (!downloaded || !ALLOWED_TYPES.includes(downloaded.contentType)) {
      result.skipped += 1;
      continue;
    }

    const outcome = await attachToTicket({
      ticketId: input.ticketId,
      commentId: input.commentId ?? null,
      file: new File([downloaded.bytes], file.name, { type: downloaded.contentType }),
      uploadedBy: input.uploadedBy ?? null,
      uploadedByName: input.uploadedByName,
      slackFileId: file.id,
    });

    if (!outcome.ok) result.skipped += 1;
    else if (outcome.duplicate) result.alreadyHere += 1;
    else result.imported += 1;
  }

  return result;
}

export interface ReplyImport {
  /** True when this call wrote the comment; false when it was already there. */
  created: boolean;
  commentId: string | null;
  authorName: string;
  body: string;
  files: FileImport;
}

/**
 * One Slack reply → one comment on the ticket, plus its files.
 *
 * When the comment already exists its files are still retried, so a reply
 * whose screenshot failed to copy the first time (files:read not granted yet,
 * a timeout) gets it on the next pass.
 */
export async function recordSlackReply(input: {
  ticketId: string;
  message: SlackThreadMessage;
  people?: People;
  /** The bot's own Slack user id. Its posts are never imported. */
  botUserId?: string | null;
}): Promise<ReplyImport> {
  const db = serviceClient();
  const people: People = input.people ?? new Map();
  const { message } = input;

  const author = message.user && message.user !== input.botUserId
    ? await person(people, message.user)
    : { name: 'Slack', hubUserId: null, isBot: false };

  /*
   * The bot's own posts do not always carry bot_id: a file it uploads into the
   * thread (a Hub attachment going to Slack) arrives as a file_share from the
   * bot's user. users.info knows it is a bot even when the event does not.
   */
  if (author.isBot || (input.botUserId && message.user === input.botUserId)) {
    return {
      created: false,
      commentId: null,
      authorName: author.name,
      body: '',
      files: { imported: 0, alreadyHere: 0, skipped: 0 },
    };
  }

  const plain = slackTextToPlain(message.text, await namesIn(people, message.text));
  const body =
    plain !== ''
      ? plain
      : message.files.length === 1
        ? 'Shared a file in Slack.'
        : `Shared ${message.files.length} files in Slack.`;

  let created = false;
  let commentId: string | null = null;

  const inserted = await db
    .from('tech_ticket_comments')
    .insert({
      ticket_id: input.ticketId,
      author_id: author.hubUserId,
      author_name: author.name,
      body,
      source: 'slack',
      slack_message_ts: message.ts,
      // Slack's own time, so a backfilled reply sorts where it happened.
      created_at: new Date(Number(message.ts) * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (inserted.error) {
    if (inserted.error.code !== UNIQUE_VIOLATION) {
      console.error('[slack-sync] comment insert failed:', inserted.error.message);
    }
    const existing = await db
      .from('tech_ticket_comments')
      .select('id')
      .eq('ticket_id', input.ticketId)
      .eq('slack_message_ts', message.ts)
      .maybeSingle();
    commentId = existing.data?.id ?? null;
  } else {
    created = true;
    commentId = inserted.data.id;
  }

  const files =
    commentId && message.files.length > 0
      ? await importSlackFiles({
          ticketId: input.ticketId,
          commentId,
          files: message.files,
          uploadedByName: author.name,
          uploadedBy: author.hubUserId,
        })
      : { imported: 0, alreadyHere: 0, skipped: 0 };

  return { created, commentId, authorName: author.name, body, files };
}

export interface ThreadSync {
  ok: boolean;
  newComments: number;
  newFiles: number;
  skippedFiles: number;
  reason?: string;
}

/**
 * Read a ticket's whole thread and copy in anything missing.
 *
 * Used by the reconcile cron (catches events Slack never delivered, and
 * backfills tickets filed before the sync existed) and by "Pull from Slack" on
 * a ticket. Sends no notifications: a backfill of old replies is not news.
 */
let cachedBotUserId: string | null = null;

/** auth.test once per server instance; works without users:read. */
export async function ownBotUserId(): Promise<string | null> {
  if (cachedBotUserId === null) cachedBotUserId = await fetchBotUserId();
  return cachedBotUserId;
}

export async function syncTicketFromSlack(
  ticketId: string,
  people: People = new Map(),
): Promise<ThreadSync> {
  const empty = { newComments: 0, newFiles: 0, skippedFiles: 0 };
  const db = serviceClient();

  const ticket = await db
    .from('tech_tickets')
    .select('id, raised_by, raised_by_name, slack_channel_id, slack_thread_ts, slack_message_ts')
    .eq('id', ticketId)
    .maybeSingle();

  if (!ticket.data) return { ok: false, ...empty, reason: 'no ticket' };

  const row = ticket.data;
  const threadTs = row.slack_thread_ts ?? row.slack_message_ts;
  if (!row.slack_channel_id || !threadTs) {
    return { ok: false, ...empty, reason: 'not a Slack ticket' };
  }

  const messages = await threadMessages(row.slack_channel_id, threadTs);
  if (messages === null) {
    return { ok: false, ...empty, reason: 'Slack could not be read' };
  }

  const result: ThreadSync = { ok: true, ...empty };
  const botUserId = await ownBotUserId();

  for (const message of messages) {
    // The message that raised the ticket: its text is the ticket body already,
    // so only its files are copied, onto the ticket itself.
    if (message.ts === row.slack_message_ts) {
      if (message.files.length > 0) {
        const files = await importSlackFiles({
          ticketId: row.id,
          files: message.files,
          uploadedByName: row.raised_by_name,
          uploadedBy: row.raised_by,
        });
        result.newFiles += files.imported;
        result.skippedFiles += files.skipped;
      }
      continue;
    }

    if (!isHumanReply(message) || message.user === botUserId) continue;

    const reply = await recordSlackReply({ ticketId: row.id, message, people, botUserId });
    if (reply.created) result.newComments += 1;
    result.newFiles += reply.files.imported;
    result.skippedFiles += reply.files.skipped;
  }

  return result;
}
