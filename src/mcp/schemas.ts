import { z } from 'zod';
import type { Company, CompanyWithDomains } from '../types/index.js';
import type { RelationshipRow } from '../repositories/relationship.js';
import { companiesAt, type Role } from '../services/roles.js';

/**
 * Output shapes for the MCP tools. Every tool returns these as `structuredContent` (validated
 * against the tool's outputSchema) and as JSON text for clients that only read text.
 * One camelCase shape per entity, shared by every tool that returns it.
 */

const isoDate = z.string().nullable().describe('ISO 8601 timestamp, or null if unknown');

export const contactSummarySchema = z.object({
  id: z.string().describe('Contact id; pass to get_contact / get_conversation_context'),
  name: z.string().nullable(),
  emails: z.array(z.string()).describe("All of the contact's known email addresses"),
  companyId: z.string(),
  companyName: z.string().nullable().describe('Company name (often its primary domain)'),
  emailsTo: z.number().describe('Emails the user sent to this contact'),
  emailsFrom: z.number().describe('Emails this contact sent to the user'),
  emailsIncluded: z.number().describe('Emails where both were recipients (cc / group threads)'),
  firstSeen: isoDate.describe('First email either way'),
  lastSeen: isoDate.describe('Last email either way, as of the last sync'),
  yourCompanyWhenMet: z
    .string()
    .nullable()
    .describe('Where the user worked at firstSeen (from MY_ROLES); null if unknown'),
  yourCompanyLastTalked: z
    .string()
    .nullable()
    .describe('Where the user worked at lastSeen (from MY_ROLES); null if unknown'),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

export const paginationSchema = z
  .object({
    page: z.number(),
    limit: z.number(),
    total: z.number().describe('Total matches across all pages'),
    totalPages: z.number().describe('Request page + 1 for more, up to this'),
  })
  .describe('Pagination of the result list');

export const contactListSchema = z.object({
  contacts: z.array(contactSummarySchema),
  pagination: paginationSchema,
});

export const companySummarySchema = z.object({
  id: z.string().describe('Company id; pass to get_company'),
  name: z.string().nullable(),
  emailsTo: z.number().describe('Emails the user sent to anyone at this company'),
  emailsFrom: z.number().describe('Emails anyone at this company sent to the user'),
  emailsIncluded: z.number(),
  firstSeen: isoDate,
  lastSeen: isoDate,
});

export const companyListSchema = z.object({
  companies: z.array(companySummarySchema),
  pagination: paginationSchema,
});

export const companyDetailSchema = companySummarySchema.extend({
  domains: z.array(z.string()).describe('Email domains that belong to this company'),
  contactCount: z.number(),
  topContacts: z.array(contactSummarySchema).describe('Strongest relationships first'),
});

const writerSchema = z
  .enum(['you', 'them', 'someone else'])
  .describe('Who sent the newest message: the user, this contact, or another participant');

export const conversationSchema = z.object({
  contact: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      addresses: z.array(z.string()),
    })
    .describe('Who was searched for; id is null if the address is not in sigparser'),
  lastTalked: z
    .object({
      date: z.string().describe('ISO timestamp of the newest message'),
      subject: z.string(),
      yourCompanyThen: z.string().nullable().describe('Where the user worked then, if known'),
      lastWriter: writerSchema,
    })
    .nullable()
    .describe('Summary of the newest thread; null if no thread was found'),
  threads: z
    .array(
      z.object({
        account: z.enum(['work', 'personal']).describe('Mailbox the thread is in'),
        threadId: z.string(),
        subject: z.string(),
        firstMessageAt: z.string(),
        lastMessageAt: z.string(),
        messageCount: z.number().describe('Messages in the whole thread'),
        lastWriter: writerSchema,
        you: z
          .object({ addresses: z.array(z.string()), company: z.string().nullable() })
          .describe("The user's addresses on the thread and their company then"),
        messages: z
          .array(
            z.object({
              date: z.string(),
              from: z.string(),
              to: z.string(),
              cc: z.string().nullable(),
              text: z
                .string()
                .describe('New text of the message; quoted history and signature removed'),
            }),
          )
          .describe('The last messages of the thread, oldest first'),
      }),
    )
    .describe('Newest threads first'),
  searchedAccounts: z.array(z.enum(['work', 'personal'])).describe('Mailboxes that were searched'),
  errors: z
    .array(z.object({ account: z.enum(['work', 'personal']).optional(), error: z.string() }))
    .describe('Per-mailbox failures; the other mailboxes still returned results'),
});

export const syncStatusSchema = z.object({
  accounts: z.array(
    z.object({
      account: z.enum(['work', 'personal']),
      lastSync: isoDate.describe('Last successful sync run'),
      catchingUp: z
        .boolean()
        .describe('True while the account backfills history; stats may be incomplete'),
      backfillDate: z.string().nullable().describe('Day being backfilled while catchingUp'),
    }),
  ),
  readableMailboxes: z
    .array(z.enum(['work', 'personal']))
    .describe('Mailboxes get_conversation_context may read'),
});

function companyAt(roles: Role[], date: string | null): string | null {
  const companies = companiesAt(roles, date);
  return companies.length > 0 ? companies.join(' / ') : null;
}

export function toContactSummary(roles: Role[], row: RelationshipRow): ContactSummary {
  return {
    id: row.id,
    name: row.name,
    emails: row.emails === null ? [] : row.emails.split(', '),
    companyId: row.company_id,
    companyName: row.company_name,
    emailsTo: row.emails_to,
    emailsFrom: row.emails_from,
    emailsIncluded: row.emails_included,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    yourCompanyWhenMet: companyAt(roles, row.first_seen),
    yourCompanyLastTalked: companyAt(roles, row.last_seen),
  };
}

export function toCompanySummary(company: Company): z.infer<typeof companySummarySchema> {
  return {
    id: company.id,
    name: company.name,
    emailsTo: company.emailsTo,
    emailsFrom: company.emailsFrom,
    emailsIncluded: company.emailsIncluded,
    firstSeen: company.firstSeen,
    lastSeen: company.lastSeen,
  };
}

export function toCompanyDetail(
  company: CompanyWithDomains,
  topContacts: ContactSummary[],
): z.infer<typeof companyDetailSchema> {
  return {
    ...toCompanySummary(company),
    domains: company.domains.map((d) => d.domain),
    contactCount: company.contactCount,
    topContacts,
  };
}
