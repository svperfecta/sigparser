import { McpServer, type CallToolResult, type GetPromptResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from '../types/index.js';
import { CompanyRepository } from '../repositories/company.js';
import { DomainRepository } from '../repositories/domain.js';
import { EmailRepository } from '../repositories/email.js';
import { RelationshipRepository, type RelationshipFilter } from '../repositories/relationship.js';
import { getConversationContext, readableAccounts } from '../services/conversation.js';
import { ownEmails, parseRoles } from '../services/roles.js';
import { getSyncStatus } from '../services/sync.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  companyDetailSchema,
  companyListSchema,
  contactListSchema,
  contactSummarySchema,
  conversationSchema,
  syncStatusSchema,
  toCompanyDetail,
  toCompanySummary,
  toContactSummary,
} from './schemas.js';

const COMPANY_SORTS = ['last_seen', 'emails_from', 'emails_to', 'first_seen', 'name'] as const;
const CONTACT_SORTS = ['strength', 'last_seen', 'emails_to', 'emails_from'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const INSTRUCTIONS = `sigparser is the user's private contact database, mined from their Gmail (work and personal).
Entities: company -> domains, company -> contacts, contact -> email addresses.
Contact stats: emailsTo (the user emailed them), emailsFrom (they emailed the user),
emailsIncluded (both on the same email), firstSeen / lastSeen (first / last email either way).
"strength" = min(emailsTo, emailsFrom): reciprocity, so newsletters and one-way senders rank low.

Typical flows:
- "Who do I know at acme.com?" -> search_contacts { domain: "acme.com" }.
- "Who should I reconnect with?" -> find_dormant_contacts, then get_conversation_context for each pick.
- "What did we last talk about?" -> get_conversation_context { email } reads Gmail live.

yourCompanyWhenMet / yourCompanyLastTalked say where the user worked at firstSeen / lastSeen; null
when the user's employment timeline (MY_ROLES) does not cover that date. get_conversation_context
returns lastTalked { date, subject, yourCompanyThen, lastWriter } so you can say e.g. "You last
talked in 2017, when you were at MadGlory, about the Q3 launch; they wrote last."

Stats come from the sync and can lag (see sync_status); get_conversation_context reads Gmail live,
so trust its dates over lastSeen. It only reads the mailboxes in sync_status.readableMailboxes.
List tools are paginated: request page + 1 until page = pagination.totalPages.
Every tool is read-only; nothing here sends or drafts email.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// Reads Gmail, an external system, at call time.
const READ_ONLY_EXTERNAL = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function ok(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// Shared input fields, described once.
const limitArg = z.number().int().min(1).max(100).default(25).describe('Results per page (1-100)');
const pageArg = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe('Page number, from 1; see pagination.totalPages in the result');
const domainArg = z
  .string()
  .optional()
  .describe(
    'Email domain such as "acme.com" or "@acme.com"; subdomains like eu.acme.com match too',
  );
const contactSortArg = z
  .enum(CONTACT_SORTS)
  .default('strength')
  .describe(
    'strength = min(emailsTo, emailsFrom), real two-way relationships first; last_seen = most ' +
      'recent first; emails_to = most emailed by the user; emails_from = most emails to the user',
  );
const contactRef = {
  id: z.string().optional().describe('Contact id from a search result (preferred)'),
  email: z.string().optional().describe('Any email address of the contact, if no id'),
};

/**
 * Build the MCP server for one request. Stateless: `createMcpHandler` builds a fresh
 * instance per request, so nothing here may hold state between calls.
 */
export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'sigparser', version: '1.1.0' },
    { instructions: INSTRUCTIONS },
  );
  const companies = new CompanyRepository(env.DB);
  const domains = new DomainRepository(env.DB);
  const emails = new EmailRepository(env.DB);
  const relationships = new RelationshipRepository(env.DB);
  const roles = parseRoles(env);
  const own = ownEmails(env, roles);

  async function findContacts(
    filter: RelationshipFilter,
    sort: (typeof CONTACT_SORTS)[number],
    limit: number,
    page: number,
  ): Promise<Record<string, unknown>> {
    const { contacts, total } = await relationships.find(
      { ...filter, excludeEmails: own },
      sort,
      limit,
      (page - 1) * limit,
    );
    return {
      contacts: contacts.map((row) => toContactSummary(roles, row)),
      pagination: paginationMeta(page, limit, total),
    };
  }

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
        'Find people by email domain and/or part of a name or email address, e.g. "who do I know ' +
        'at acme.com?". With no filters, lists everyone. ' +
        'Returns: { contacts: ContactSummary[], pagination }, where each contact has its addresses, ' +
        'company, email counts in both directions, first/last seen, and where the user worked then.',
      inputSchema: z.object({
        domain: domainArg,
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the name or of any email address'),
        two_way_only: z
          .boolean()
          .default(false)
          .describe('Only people who emailed the user AND were emailed by the user'),
        sort: contactSortArg,
        limit: limitArg,
        page: pageArg,
      }),
      outputSchema: contactListSchema,
      annotations: READ_ONLY,
    },
    async ({ domain, query, two_way_only, sort, limit, page }) => {
      const minimum = two_way_only ? 1 : 0;
      return ok(
        await findContacts(
          { domain, query, minEmailsTo: minimum, minEmailsFrom: minimum },
          sort,
          limit,
          page,
        ),
      );
    },
  );

  server.registerTool(
    'find_dormant_contacts',
    {
      title: 'Find people to reconnect with',
      description:
        'Real two-way relationships that have gone quiet: people the user exchanged email with, ' +
        'but not in the last quiet_for_days. Use for "who should I reconnect with?". Then call ' +
        'get_conversation_context on the picks to see the last topic. ' +
        'Returns: { contacts: ContactSummary[], pagination }, strongest relationships first by default.',
      inputSchema: z.object({
        quiet_for_days: z
          .number()
          .int()
          .min(1)
          .default(365)
          .describe('No email in either direction for at least this many days'),
        active_within_days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Only relationships whose last email is within this many days (e.g. 1825 = 5 years), ' +
              'to skip ancient contacts',
          ),
        min_emails_to: z
          .number()
          .int()
          .min(0)
          .default(3)
          .describe('Minimum emails the user sent to them'),
        min_emails_from: z
          .number()
          .int()
          .min(0)
          .default(2)
          .describe('Minimum emails they sent to the user'),
        domain: domainArg,
        sort: contactSortArg,
        limit: limitArg,
        page: pageArg,
      }),
      outputSchema: contactListSchema,
      annotations: READ_ONLY,
    },
    async (args) =>
      ok(
        await findContacts(
          {
            domain: args.domain,
            minEmailsTo: args.min_emails_to,
            minEmailsFrom: args.min_emails_from,
            lastSeenBefore: daysAgoIso(args.quiet_for_days),
            lastSeenAfter:
              args.active_within_days !== undefined
                ? daysAgoIso(args.active_within_days)
                : undefined,
          },
          args.sort,
          args.limit,
          args.page,
        ),
      ),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description:
        'One person by id or by any of their email addresses. ' +
        'Returns: ContactSummary (addresses, company, email counts, first/last seen, where the user worked then).',
      inputSchema: z.object(contactRef),
      outputSchema: contactSummarySchema,
      annotations: READ_ONLY,
    },
    async ({ id, email }) => {
      const contactId = await resolveContactId(id, email);
      if (contactId === undefined) {
        return fail('Not found: pass a contact id, or an email address that sigparser knows.');
      }
      const { contacts } = await relationships.find({ contactId }, 'strength', 1, 0);
      const row = contacts[0];
      return row === undefined
        ? fail(`Contact ${contactId} not found.`)
        : ok(toContactSummary(roles, row));
    },
  );

  server.registerTool(
    'get_conversation_context',
    {
      title: 'Last conversation with a contact',
      description:
        "Reads Gmail live for the newest threads with any of a person's addresses. Use before " +
        'reaching out, to know what was last discussed, when, and who wrote last. Works for ' +
        'addresses sigparser does not know too. ' +
        'Returns: { contact, lastTalked: { date, subject, yourCompanyThen, lastWriter } | null, ' +
        'threads: [{ subject, dates, lastWriter, you, messages: [{ date, from, to, cc, text }] }], ' +
        'searchedAccounts, errors }. Message text has quoted history and signatures removed.',
      inputSchema: z.object({
        ...contactRef,
        threads: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(1)
          .describe('How many recent threads to return, newest first'),
        messages_per_thread: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe('How many of the last messages to include from each thread'),
      }),
      outputSchema: conversationSchema,
      annotations: READ_ONLY_EXTERNAL,
    },
    async ({ id, email, threads, messages_per_thread }) => {
      const options = { threads, messagesPerThread: messages_per_thread };
      const contactId = await resolveContactId(id, email);
      if (contactId === undefined) {
        if (email === undefined) {
          return fail('Not found: pass a contact id, or an email address.');
        }
        // Unknown to sigparser, but Gmail may still know them.
        const address = email.trim().toLowerCase();
        const context = await getConversationContext(env, [address], options);
        return ok({ contact: { id: null, name: null, addresses: [address] }, ...context });
      }
      const { contacts } = await relationships.find({ contactId }, 'strength', 1, 0);
      const addresses = (await emails.findByContactId(contactId)).map((e) => e.email);
      if (addresses.length === 0) {
        return fail(`Contact ${contactId} has no email addresses.`);
      }
      const context = await getConversationContext(env, addresses, options);
      return ok({
        contact: { id: contactId, name: contacts[0]?.name ?? null, addresses },
        ...context,
      });
    },
  );

  server.registerTool(
    'search_companies',
    {
      title: 'Search companies',
      description:
        'Find companies by part of the company name or of one of its email domains. With no ' +
        'query, lists all. Returns: { companies: CompanySummary[], pagination }; each has email ' +
        'counts across everyone at the company and first/last seen. Use get_company for people.',
      inputSchema: z.object({
        query: z.string().optional().describe('Case-insensitive substring of name or domain'),
        sort: z
          .enum(COMPANY_SORTS)
          .default('last_seen')
          .describe(
            'last_seen = most recent contact; emails_from / emails_to = volume; first_seen; name',
          ),
        order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
        limit: limitArg,
        page: pageArg,
      }),
      outputSchema: companyListSchema,
      annotations: READ_ONLY,
    },
    async ({ query, sort, order, limit, page }) => {
      const pagination = parsePagination(
        { page: String(page), limit: String(limit), sort, order },
        'last_seen',
        [...COMPANY_SORTS],
      );
      const { companies: rows, total } = await companies.list(pagination, query);
      return ok({
        companies: rows.map(toCompanySummary),
        pagination: paginationMeta(page, limit, total),
      });
    },
  );

  server.registerTool(
    'get_company',
    {
      title: 'Get company',
      description:
        'One company by id or by one of its email domains, with the people the user knows there. ' +
        'Returns: CompanySummary + { domains, contactCount, topContacts: ContactSummary[] } ' +
        '(strongest relationships first).',
      inputSchema: z.object({
        id: z.string().optional().describe('Company id from a search result (preferred)'),
        domain: z.string().optional().describe('One of its email domains, e.g. "acme.com"'),
        contact_limit: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(25)
          .describe('How many contacts to include in topContacts (0 for none)'),
      }),
      outputSchema: companyDetailSchema,
      annotations: READ_ONLY,
    },
    async ({ id, domain, contact_limit }) => {
      let companyId = id;
      if (companyId === undefined && domain !== undefined) {
        companyId = (await domains.findByDomain(domain.trim().toLowerCase().replace(/^@/, '')))
          ?.companyId;
      }
      if (companyId === undefined) {
        return fail('Not found: pass a company id, or a domain that sigparser knows.');
      }
      const company = await companies.findByIdWithDomains(companyId);
      if (company === null) {
        return fail(`Company ${companyId} not found.`);
      }
      const top =
        contact_limit > 0
          ? (
              await relationships.find(
                { companyId, excludeEmails: own },
                'strength',
                contact_limit,
                0,
              )
            ).contacts
          : [];
      return ok(
        toCompanyDetail(
          company,
          top.map((row) => toContactSummary(roles, row)),
        ),
      );
    },
  );

  server.registerTool(
    'sync_status',
    {
      title: 'Sync status',
      description:
        'How current the data is, per Gmail account, and which mailboxes get_conversation_context ' +
        'may read. Check when lastSeen dates look stale. ' +
        'Returns: { accounts: [{ account, lastSync, catchingUp, backfillDate }], readableMailboxes }.',
      inputSchema: z.object({}),
      outputSchema: syncStatusSchema,
      annotations: READ_ONLY,
    },
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const accounts = (await getSyncStatus(env.DB)).map((s) => {
        const catchingUp = s.batchCurrentDate !== null && s.batchCurrentDate <= today;
        return {
          account: s.account,
          lastSync: s.lastSync,
          catchingUp,
          backfillDate: catchingUp ? s.batchCurrentDate : null,
        };
      });
      return ok({ accounts, readableMailboxes: readableAccounts(env) });
    },
  );

  server.registerPrompt(
    'reconnect',
    {
      title: 'Reconnect with someone',
      description:
        'Look up a person and the last conversation, then draft a short note to reopen it.',
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
              '1. Find them with search_contacts (query = name or email).\n' +
              '2. Call get_conversation_context with threads: 3 to see what we last talked about, when, and who wrote last.\n' +
              '3. Summarize the relationship in 3 bullets: how long we have known each other (and where I worked then), volume, last topic.\n' +
              '4. Draft a short, warm email that picks up from the last topic. No "just checking in" filler; ' +
              'reference something specific. If they wrote last and I never replied, acknowledge it.',
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
              '4. Give me a table: name, company, where I was then, last contact, last topic, ' +
              'and a one-line reason to reach out.',
          },
        },
      ],
    }),
  );

  return server;
}
