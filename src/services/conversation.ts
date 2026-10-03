import type { Env } from '../types/index.js';
import type { AccountType } from './sync.js';
import { GmailService, type GmailFullMessage, type GmailMessagePart } from './gmail.js';
import { companiesAt, companyForAddress, ownEmails, parseRoles, type Role } from './roles.js';
import { parseEmailHeader } from '../utils/email.js';

/**
 * Live conversation context for the MCP surface. sigparser stores no message text, so this
 * searches Gmail at request time for the newest threads involving a contact's addresses and
 * returns subject, participants and the tail of each thread.
 *
 * Only the mailboxes named in MCP_GMAIL_ACCOUNTS (default: work) are ever read.
 */

const DEFAULT_ACCOUNTS: AccountType[] = ['work'];
const MAX_CHARS_PER_MESSAGE = 2000;

export interface ConversationMessage {
  date: string;
  from: string;
  to: string;
  cc: string | null;
  text: string;
}

export type Writer = 'you' | 'them' | 'someone else';

export interface ConversationThread {
  account: AccountType;
  threadId: string;
  subject: string;
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  /** Who sent the newest message in the thread. */
  lastWriter: Writer;
  /** The user's side of the thread: which of their addresses took part, and where they worked. */
  you: { addresses: string[]; company: string | null };
  messages: ConversationMessage[];
}

/** The newest thread boiled down: "You last talked in 2017, at MadGlory, about X; they wrote last." */
export interface LastTalked {
  date: string;
  subject: string;
  yourCompanyThen: string | null;
  lastWriter: Writer;
}

export interface ConversationContext {
  lastTalked: LastTalked | null;
  threads: ConversationThread[];
  searchedAccounts: AccountType[];
  errors: { account?: AccountType; error: string }[];
}

/** Mailboxes the MCP surface may read, filtered to those with a refresh token. */
export function readableAccounts(env: Env): AccountType[] {
  const configured = (env.MCP_GMAIL_ACCOUNTS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a): a is AccountType => a === 'work' || a === 'personal');
  const wanted = configured.length > 0 ? configured : DEFAULT_ACCOUNTS;
  return wanted.filter((a) => refreshTokenFor(env, a) !== undefined);
}

function refreshTokenFor(env: Env, account: AccountType): string | undefined {
  const token =
    account === 'work' ? env.GMAIL_REFRESH_TOKEN_WORK : env.GMAIL_REFRESH_TOKEN_PERSONAL;
  return token !== undefined && token !== '' ? token : undefined;
}

function gmailFor(env: Env, account: AccountType): GmailService | null {
  const refreshToken = refreshTokenFor(env, account);
  if (refreshToken === undefined) {
    return null;
  }
  return new GmailService({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken,
  });
}

/**
 * Plain email addresses only. Addresses go into a Gmail search query, so anything that could
 * carry search operators (spaces, braces, parentheses, quotes, colons) is refused; otherwise a
 * caller could widen the search to the whole mailbox.
 */
const SAFE_ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function isSafeAddress(address: string): boolean {
  return SAFE_ADDRESS.test(address);
}

/**
 * Gmail search query matching any message to/from/cc any of the addresses, or null when no
 * address is safe to search for.
 */
export function addressQuery(addresses: string[]): string | null {
  const safe = addresses.map((a) => a.trim().toLowerCase()).filter(isSafeAddress);
  if (safe.length === 0) {
    return null;
  }
  const terms = safe.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]);
  return `{${terms.join(' ')}}`;
}

function header(part: GmailMessagePart, name: string): string | null {
  const h = part.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function findPart(part: GmailMessagePart, mimeType: string): GmailMessagePart | null {
  if (part.mimeType === mimeType && part.body?.data !== undefined) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Plain-text body with quoted history removed, so each message shows only what was new.
 */
export function messageText(message: GmailFullMessage): string {
  const plain = findPart(message.payload, 'text/plain');
  const html = plain === null ? findPart(message.payload, 'text/html') : null;
  let text: string;
  if (plain?.body?.data !== undefined) {
    text = decodeBase64Url(plain.body.data);
  } else if (html?.body?.data !== undefined) {
    text = htmlToText(decodeBase64Url(html.body.data));
  } else {
    text = message.snippet;
  }

  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (
      /^On .+wrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message/i.test(line) ||
      /^From: .+/.test(line)
    ) {
      break;
    }
    if (!line.startsWith('>')) {
      lines.push(line);
    }
  }
  const cleaned = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > MAX_CHARS_PER_MESSAGE
    ? `${cleaned.slice(0, MAX_CHARS_PER_MESSAGE)}…`
    : cleaned;
}

function addressesIn(part: GmailMessagePart, names: string[]): string[] {
  return names.flatMap((name) => {
    const value = header(part, name);
    return value === null ? [] : parseEmailHeader(value).map((p) => p.email.toLowerCase());
  });
}

/**
 * The user's addresses on a thread (known own addresses, plus Delivered-To, which is always the
 * mailbox's own) and the company they were at: by address if a role lists it, else by date.
 */
function yourSide(
  messages: GmailFullMessage[],
  own: Set<string>,
  roles: Role[],
  lastMessageAt: string,
): { addresses: string[]; company: string | null } {
  const found = new Set<string>();
  for (const message of messages) {
    for (const address of addressesIn(message.payload, ['From', 'To', 'Cc'])) {
      if (own.has(address)) {
        found.add(address);
      }
    }
    for (const address of addressesIn(message.payload, ['Delivered-To'])) {
      found.add(address);
    }
  }
  const addresses = [...found];
  const byAddress = addresses
    .map((a) => companyForAddress(roles, a))
    .find((c): c is string => c !== null);
  const byDate = companiesAt(roles, lastMessageAt);
  return { addresses, company: byAddress ?? (byDate.length > 0 ? byDate.join(' / ') : null) };
}

function writerOf(message: GmailFullMessage, own: Set<string>, contact: Set<string>): Writer {
  const from = addressesIn(message.payload, ['From'])[0];
  if (from !== undefined && own.has(from)) {
    return 'you';
  }
  if (from !== undefined && contact.has(from)) {
    return 'them';
  }
  return 'someone else';
}

function toConversationMessage(message: GmailFullMessage): ConversationMessage {
  return {
    date: new Date(parseInt(message.internalDate, 10)).toISOString(),
    from: header(message.payload, 'From') ?? '',
    to: header(message.payload, 'To') ?? '',
    cc: header(message.payload, 'Cc'),
    text: messageText(message),
  };
}

/**
 * Newest threads involving any of `addresses`, across the readable mailboxes, newest first.
 */
export async function getConversationContext(
  env: Env,
  addresses: string[],
  options: { threads: number; messagesPerThread: number },
): Promise<ConversationContext> {
  const query = addressQuery(addresses);
  if (query === null) {
    return {
      lastTalked: null,
      threads: [],
      searchedAccounts: [],
      errors: [{ error: 'No valid email address to search for' }],
    };
  }
  const accounts = readableAccounts(env);
  const roles = parseRoles(env);
  const own = new Set(ownEmails(env, roles));
  const contactAddresses = new Set(addresses.map((a) => a.toLowerCase()));
  const errors: ConversationContext['errors'] = [];
  const threads: ConversationThread[] = [];

  await Promise.all(
    accounts.map(async (account) => {
      const gmail = gmailFor(env, account);
      if (gmail === null) {
        return;
      }
      try {
        const list = await gmail.listMessages({ q: query, maxResults: 25 });
        const threadIds = [...new Set((list.messages ?? []).map((m) => m.threadId))].slice(
          0,
          options.threads,
        );
        for (const threadId of threadIds) {
          const thread = await gmail.getThread(threadId);
          const messages = thread.messages ?? [];
          const last = messages[messages.length - 1];
          const first = messages[0];
          if (last === undefined || first === undefined) {
            continue;
          }
          const lastMessageAt = new Date(parseInt(last.internalDate, 10)).toISOString();
          threads.push({
            account,
            threadId,
            subject: header(first.payload, 'Subject') ?? '(no subject)',
            firstMessageAt: new Date(parseInt(first.internalDate, 10)).toISOString(),
            lastMessageAt,
            messageCount: messages.length,
            lastWriter: writerOf(last, own, contactAddresses),
            you: yourSide(messages, own, roles, lastMessageAt),
            messages: messages.slice(-options.messagesPerThread).map(toConversationMessage),
          });
        }
      } catch (error) {
        errors.push({ account, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );

  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  const newest = threads[0];
  const lastTalked: LastTalked | null =
    newest === undefined
      ? null
      : {
          date: newest.lastMessageAt,
          subject: newest.subject,
          yourCompanyThen: newest.you.company,
          lastWriter: newest.lastWriter,
        };
  return {
    lastTalked,
    threads: threads.slice(0, options.threads),
    searchedAccounts: accounts,
    errors,
  };
}
