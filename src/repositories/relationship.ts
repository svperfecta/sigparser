/**
 * Relationship-oriented contact queries for the MCP surface: contacts with their addresses and
 * company in one row, filtered by email domain and by how long the relationship has been quiet.
 */

export interface RelationshipRow {
  id: string;
  name: string | null;
  company_id: string;
  company_name: string | null;
  emails: string | null;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface RelationshipFilter {
  /** Exact domain, also matching subdomains (acme.com matches eu.acme.com). */
  domain?: string | undefined;
  /** Substring match on name or email address. */
  query?: string | undefined;
  companyId?: string | undefined;
  contactId?: string | undefined;
  minEmailsTo?: number;
  minEmailsFrom?: number;
  lastSeenBefore?: string | undefined;
  lastSeenAfter?: string | undefined;
  /** Contacts owning any of these addresses are left out (the user's own addresses). */
  excludeEmails?: string[];
}

export type RelationshipSort = 'strength' | 'last_seen' | 'emails_to' | 'emails_from';

const ORDER_BY: Record<RelationshipSort, string> = {
  // Reciprocity: a newsletter with 5,000 received and 2 sent scores 2, not 5,002.
  strength: 'min(c.emails_to, c.emails_from) DESC, (c.emails_to + c.emails_from) DESC',
  last_seen: 'c.last_seen DESC',
  emails_to: 'c.emails_to DESC',
  emails_from: 'c.emails_from DESC',
};

export class RelationshipRepository {
  constructor(private db: D1Database) {}

  async find(
    filter: RelationshipFilter,
    sort: RelationshipSort,
    limit: number,
    offset: number,
  ): Promise<{ contacts: RelationshipRow[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.domain !== undefined && filter.domain !== '') {
      const domain = filter.domain.trim().toLowerCase().replace(/^@/, '');
      conditions.push(
        "c.id IN (SELECT contact_id FROM emails WHERE domain = ? OR domain LIKE '%.' || ?)",
      );
      params.push(domain, domain);
    }
    if (filter.query !== undefined && filter.query !== '') {
      conditions.push(
        '(c.name LIKE ? OR c.id IN (SELECT contact_id FROM emails WHERE email LIKE ?))',
      );
      params.push(`%${filter.query}%`, `%${filter.query}%`);
    }
    if (filter.contactId !== undefined) {
      conditions.push('c.id = ?');
      params.push(filter.contactId);
    }
    if (filter.companyId !== undefined) {
      conditions.push('c.company_id = ?');
      params.push(filter.companyId);
    }
    if (filter.minEmailsTo !== undefined && filter.minEmailsTo > 0) {
      conditions.push('c.emails_to >= ?');
      params.push(filter.minEmailsTo);
    }
    if (filter.minEmailsFrom !== undefined && filter.minEmailsFrom > 0) {
      conditions.push('c.emails_from >= ?');
      params.push(filter.minEmailsFrom);
    }
    if (filter.lastSeenBefore !== undefined) {
      conditions.push('c.last_seen < ?');
      params.push(filter.lastSeenBefore);
    }
    if (filter.lastSeenAfter !== undefined) {
      conditions.push('c.last_seen >= ?');
      params.push(filter.lastSeenAfter);
    }

    if (filter.excludeEmails !== undefined && filter.excludeEmails.length > 0) {
      const placeholders = filter.excludeEmails.map(() => '?').join(', ');
      conditions.push(
        `c.id NOT IN (SELECT contact_id FROM emails WHERE email IN (${placeholders}))`,
      );
      params.push(...filter.excludeEmails);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const count = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM contacts c ${where}`)
      .bind(...params)
      .first<{ count: number }>();

    const rows = await this.db
      .prepare(
        `SELECT c.id, c.name, c.company_id, co.name AS company_name,
                (SELECT group_concat(e.email, ', ') FROM emails e WHERE e.contact_id = c.id) AS emails,
                c.emails_to, c.emails_from, c.emails_included, c.first_seen, c.last_seen
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         ${where}
         ORDER BY ${ORDER_BY[sort]}
         LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<RelationshipRow>();

    return { contacts: rows.results, total: count?.count ?? 0 };
  }
}
