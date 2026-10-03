import { McpServer, type CallToolResult, type GetPromptResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from '../types/index.js';
import { CompanyRepository } from '../repositories/company.js';
import { ContactRepository } from '../repositories/contact.js';
import { DomainRepository } from '../repositories/domain.js';
import { EmailRepository } from '../repositories/email.js';
import { RelationshipRepository } from '../repositories/relationship.js';
import { getConversationContext, readableAccounts } from '../services/conversation.js';
import { companiesAt, ownEmails, parseRoles, type Role } from '../services/roles.js';
import { getSyncStatus } from '../services/sync.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';

const COMPANY_SORTS = [
  'emails_from',
  'emails_to',
  'last_seen',
  'first_seen',
  'name',
  'created_at',
] as const;
const RELATIONSHIP_SORTS = ['strength', 'last_seen', 'emails_to', 'emails_from'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const INSTRUCTIONS = `sigparser is the user's private contact database, mined from their Gmail (work and personal).
Entities: company -> domains, company -> contacts, contact -> email addresses.
Per-contact stats: emails_to (the user emailed them), emails_from (they emailed the user),
emails_included (cc'd together), first_seen / last_seen (ISO timestamps of the last email either way).
"strength" = min(emails_to, emails_from): reciprocity, so newsletters and one-way senders rank low.

Typical flows:
- "Who do I know at acme.com?" -> search_contacts { domain: "acme.com" }.
- "Who should I reconnect with?" -> find_dormant_contacts, then get_conversation_context for each pick.
- "What did we last talk about?" -> get_conversation_context { email } returns the newest Gmail threads live.

yourCompanyWhenMet / yourCompanyLastTalked say where the user worked at first_seen / last_seen
(from the user's MY_ROLES timeline; null if not configured). get_conversation_context returns
lastTalked { date, subject, yourCompanyThen, lastWriter } so you can say e.g. "You last talked in
2017, when you were at MadGlory, about the Q3 launch; they wrote last."

Stats come from the sync and can lag; get_conversation_context reads Gmail live, so trust its dates
over last_seen. It only reads the mailboxes listed in sync_status.readableMailboxes.
Every tool is read-only; nothing here sends or drafts email.`;

function asToolResult(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// Reads Gmail, an external system, at call time.
const READ_ONLY_EXTERNAL = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

/** Tag relationship rows with where the user worked when they met and when they last talked. */
function withYourCompany<T extends { first_seen: string | null; last_seen: string | null }>(
  roles: Role[],
  rows: T[],
): (T & { yourCompanyWhenMet: string | null; yourCompanyLastTalked: string | null })[] {
  const at = (date: string | null): string | null => {
    const companies = companiesAt(roles, date);
    return companies.length > 0 ? companies.join(' / ') : null;
  };
  return rows.map((row) => ({
    ...row,
    yourCompanyWhenMet: at(row.first_seen),
    yourCompanyLastTalked: at(row.last_seen),
  }));
}

const contactRef = {
  id: z.string().optional().describe('Contact id from a search result'),
  email: z.string().optional().describe('Any email address of the contact'),
};

/**
 * Build the MCP server for one request. Stateless: `createMcpHandler` builds a fresh
 * instance per request, so nothing here may hold state between calls.
 */
export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'sigparser', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const contacts = new ContactRepository(env.DB);
  const companies = new CompanyRepository(env.DB);
  const domains = new DomainRepository(env.DB);
  const emails = new EmailRepository(env.DB);
  const relationships = new RelationshipRepository(env.DB);
  const roles = parseRoles(env);
  const own = ownEmails(env, roles);

  async function resolveContactId(id?: string, email?: string): Promise<string | undefined> {
    if (id !== undefined) {
      return id;
    }
    if (email !== undefined) {
      return (await emails.findByEmail(email.trim().toLowerCase()))?.contactId;
    }
    return undefined;
  }

  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts',
      description:
        'Find contacts by email domain (includes subdomains), and/or a substring of name or email. ' +
        'Returns addresses, company and interaction stats. Sort by strength (reciprocity, default), last_seen, emails_to or emails_from.',
      inputSchema: z.object({
        domain: z.string().optional().describe('Email domain, e.g. "acme.com" or "@acme.com"'),
        query: z.string().optional().describe('Substring of name or email address'),
        two_way_only: z
          .boolean()
          .default(false)
          .describe('Only people who both emailed the user and were emailed by the user'),
        sort: z.enum(RELATIONSHIP_SORTS).default('strength'),
        limit: z.number().int().min(1).max(100).default(25),
        page: z.number().int().min(1).default(1),
      }),
      annotations: READ_ONLY,
    },
    async ({ domain, query, two_way_only, sort, limit, page }) => {
      const minimum = two_way_only ? 1 : 0;
      const { contacts: rows, total } = await relationships.find(
        {
          domain,
          query,
          minEmailsTo: minimum,
          minEmailsFrom: minimum,
          excludeEmails: own,
        },
        sort,
        limit,
        (page - 1) * limit,
      );
      return asToolResult({
        contacts: withYourCompany(roles, rows),
        pagination: paginationMeta(page, limit, total),
      });
    },
  );

  server.registerTool(
    'find_dormant_contacts',
    {
      title: 'Find people to reconnect with',
      description:
        'Real two-way relationships that have gone quiet: people the user exchanged email with ' +
        '(at least min_emails_to sent and min_emails_from received) but not in the last quiet_for_days. ' +
        'Ranked by relationship strength by default. Follow up with get_conversation_context for the last thread.',
      inputSchema: z.object({
        quiet_for_days: z
          .number()
          .int()
          .min(1)
          .default(365)
          .describe('No email either way for this long'),
        active_within_days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Ignore relationships that ended longer ago than this (e.g. 1825 for 5 years)'),
        min_emails_to: z.number().int().min(0).default(3),
        min_emails_from: z.number().int().min(0).default(2),
        domain: z.string().optional().describe('Limit to one email domain'),
        sort: z.enum(RELATIONSHIP_SORTS).default('strength'),
        limit: z.number().int().min(1).max(100).default(25),
        page: z.number().int().min(1).default(1),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const { contacts: rows, total } = await relationships.find(
        {
          domain: args.domain,
          minEmailsTo: args.min_emails_to,
          minEmailsFrom: args.min_emails_from,
          lastSeenBefore: daysAgoIso(args.quiet_for_days),
          lastSeenAfter:
            args.active_within_days !== undefined ? daysAgoIso(args.active_within_days) : undefined,
          excludeEmails: own,
        },
        args.sort,
        args.limit,
        (args.page - 1) * args.limit,
      );
      return asToolResult({
        contacts: withYourCompany(roles, rows),
        pagination: paginationMeta(args.page, args.limit, total),
        note: 'last_seen comes from the sync and can lag; confirm with get_conversation_context.',
      });
    },
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description: 'One contact with all email addresses, company and stats. Pass id or email.',
      inputSchema: z.object(contactRef),
      annotations: READ_ONLY,
    },
    async ({ id, email }) => {
      const contactId = await resolveContactId(id, email);
      if (contactId === undefined) {
        return asToolResult({ error: 'Pass id or a known email address' });
      }
      const contact = await contacts.findByIdWithDetails(contactId);
      return asToolResult(contact ?? { error: 'Contact not found' });
    },
  );

  server.registerTool(
    'get_conversation_context',
    {
      title: 'Last conversation with a contact',
      description:
        "Reads Gmail live for the newest threads involving any of the contact's addresses. Returns subject, " +
        'date, participants and the text of the last messages in each thread (quoted history stripped). ' +
        'Use before reaching out, to know what was last discussed and who spoke last.',
      inputSchema: z.object({
        ...contactRef,
        threads: z.number().int().min(1).max(5).default(1),
        messages_per_thread: z.number().int().min(1).max(10).default(3),
      }),
      annotations: READ_ONLY_EXTERNAL,
    },
    async ({ id, email, threads, messages_per_thread }) => {
      const contactId = await resolveContactId(id, email);
      if (contactId === undefined) {
        // Unknown to sigparser, but Gmail may still know them.
        if (email === undefined) {
          return asToolResult({ error: 'Pass id or email' });
        }
        return asToolResult(
          await getConversationContext(env, [email.trim().toLowerCase()], {
            threads,
            messagesPerThread: messages_per_thread,
          }),
        );
      }
      const addresses = (await emails.findByContactId(contactId)).map((e) => e.email);
      if (addresses.length === 0) {
        return asToolResult({ error: 'Contact has no email addresses' });
      }
      const contact = await contacts.findById(contactId);
      const context = await getConversationContext(env, addresses, {
        threads,
        messagesPerThread: messages_per_thread,
      });
      return asToolResult({
        contact: { id: contactId, name: contact?.name ?? null, addresses },
        ...context,
      });
    },
  );

  server.registerTool(
    'search_companies',
    {
      title: 'Search companies',
      description: 'Search and list companies by substring of company name or domain.',
      inputSchema: z.object({
        query: z.string().optional(),
        sort: z.enum(COMPANY_SORTS).default('last_seen'),
        order: z.enum(['asc', 'desc']).default('desc'),
        limit: z.number().int().min(1).max(100).default(25),
        page: z.number().int().min(1).default(1),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, sort, order, limit, page }) => {
      const pagination = parsePagination(
        { page: String(page), limit: String(limit), sort, order },
        'last_seen',
        [...COMPANY_SORTS],
      );
      const { companies: rows, total } = await companies.list(pagination, query);
      return asToolResult({ companies: rows, pagination: paginationMeta(page, limit, total) });
    },
  );

  server.registerTool(
    'get_company',
    {
      title: 'Get company',
      description:
        'One company with its domains, contact count and strongest contacts. Pass id or domain.',
      inputSchema: z.object({
        id: z.string().optional(),
        domain: z.string().optional(),
        contact_limit: z.number().int().min(0).max(100).default(25),
      }),
      annotations: READ_ONLY,
    },
    async ({ id, domain, contact_limit }) => {
      let companyId = id;
      if (companyId === undefined && domain !== undefined) {
        companyId = (await domains.findByDomain(domain.trim().toLowerCase().replace(/^@/, '')))
          ?.companyId;
      }
      if (companyId === undefined) {
        return asToolResult({ error: 'Pass id or a known domain' });
      }
      const company = await companies.findByIdWithDomains(companyId);
      if (company === null) {
        return asToolResult({ error: 'Company not found' });
      }
      const top =
        contact_limit > 0
          ? await contacts.list(
              parsePagination({ limit: String(contact_limit) }, 'emails_from', ['emails_from']),
              undefined,
              companyId,
            )
          : { contacts: [] };
      return asToolResult({ ...company, topContacts: top.contacts });
    },
  );

  server.registerTool(
    'sync_status',
    {
      title: 'Sync status',
      description:
        'Gmail sync state per account and which mailboxes get_conversation_context may read. Use to judge freshness.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      asToolResult({
        accounts: await getSyncStatus(env.DB),
        readableMailboxes: readableAccounts(env),
      }),
  );

  server.registerPrompt(
    'reconnect',
    {
      title: 'Reconnect with someone',
      description:
        'Look up a contact and their last conversation, then draft a natural note to reopen it.',
      argsSchema: z.object({
        who: z.string().describe('Name or email address'),
        goal: z.string().optional().describe('Optional reason for reaching out'),
      }),
    },
    ({ who, goal }): GetPromptResult => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want to reconnect with ${who}.${goal !== undefined ? ` My goal: ${goal}.` : ''}\n\n` +
              '1. Find them with search_contacts (by email, or name via query).\n' +
              '2. Call get_conversation_context with threads: 3 to see what we last talked about, when, and who replied last.\n' +
              '3. Summarize the relationship in 3 bullets (how long we have known each other, volume, last topic).\n' +
              '4. Draft a short, warm email that picks up from the last topic. No "just checking in" filler; ' +
              'reference something specific. If they were the last to write and I never replied, acknowledge it.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'who_to_reconnect_with',
    {
      title: 'Who should I reconnect with?',
      description: 'Rank quiet relationships worth reopening, with the last topic for each.',
      argsSchema: z.object({
        domain: z.string().optional().describe('Optional email domain to focus on'),
      }),
    },
    ({ domain }): GetPromptResult => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Help me find people worth reconnecting with' +
              (domain !== undefined ? ` at ${domain}` : '') +
              '.\n\n' +
              '1. Call find_dormant_contacts (quiet_for_days 365, active_within_days 2555' +
              (domain !== undefined ? `, domain "${domain}"` : '') +
              ', limit 20).\n' +
              '2. Skip obvious vendors, recruiters and automated senders.\n' +
              '3. For the top 8, call get_conversation_context and note the last topic and date.\n' +
              '4. Give me a table: name, company, last contact, last topic, a one-line reason to reach out.',
          },
        },
      ],
    }),
  );

  return server;
}
