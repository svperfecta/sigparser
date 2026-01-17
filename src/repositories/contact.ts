import type { Contact, ContactRow, ContactWithEmails, Email, Company, ThreadReference } from '../types/index.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/date.js';
import { MAX_THREADS_PER_CONTACT } from '../types/constants.js';
import type { ParsedPagination } from '../utils/pagination.js';

export class ContactRepository {
  constructor(private db: D1Database) {}

  /**
   * Find a contact by ID
   */
  async findById(id: string): Promise<Contact | null> {
    const row = await this.db
      .prepare('SELECT * FROM contacts WHERE id = ?')
      .bind(id)
      .first<ContactRow>();

    if (row === null) {
      return null;
    }

    return this.rowToContact(row);
  }

  /**
   * Find a contact by ID with emails and company
   */
  async findByIdWithDetails(id: string): Promise<ContactWithEmails | null> {
    const contact = await this.findById(id);
    if (contact === null) {
      return null;
    }

    const [emailsResult, companyResult] = await Promise.all([
      this.db
        .prepare('SELECT * FROM emails WHERE contact_id = ? ORDER BY emails_from DESC')
        .bind(id)
        .all<{
          email: string;
          contact_id: string;
          domain: string;
          name_observed: string | null;
          is_active: number;
          emails_to: number;
          emails_from: number;
          emails_included: number;
          meetings_completed: number;
          meetings_upcoming: number;
          recent_threads: string;
          first_seen: string | null;
          last_seen: string | null;
          created_at: string;
          updated_at: string;
        }>(),
      this.db
        .prepare('SELECT * FROM companies WHERE id = ?')
        .bind(contact.companyId)
        .first<{
          id: string;
          name: string | null;
          emails_to: number;
          emails_from: number;
          emails_included: number;
          meetings_completed: number;
          meetings_upcoming: number;
          first_seen: string | null;
          last_seen: string | null;
          created_at: string;
          updated_at: string;
        }>(),
    ]);

    const emails: Email[] = emailsResult.results.map((row) => ({
      email: row.email,
      contactId: row.contact_id,
      domain: row.domain,
      nameObserved: row.name_observed,
      isActive: row.is_active === 1,
      emailsTo: row.emails_to,
      emailsFrom: row.emails_from,
      emailsIncluded: row.emails_included,
      meetingsCompleted: row.meetings_completed,
      meetingsUpcoming: row.meetings_upcoming,
      recentThreads: JSON.parse(row.recent_threads) as ThreadReference[],
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const company: Company = companyResult !== null
      ? {
          id: companyResult.id,
          name: companyResult.name,
          emailsTo: companyResult.emails_to,
          emailsFrom: companyResult.emails_from,
          emailsIncluded: companyResult.emails_included,
          meetingsCompleted: companyResult.meetings_completed,
          meetingsUpcoming: companyResult.meetings_upcoming,
          firstSeen: companyResult.first_seen,
          lastSeen: companyResult.last_seen,
          createdAt: companyResult.created_at,
          updatedAt: companyResult.updated_at,
        }
      : {
          id: contact.companyId,
          name: null,
          emailsTo: 0,
          emailsFrom: 0,
          emailsIncluded: 0,
          meetingsCompleted: 0,
          meetingsUpcoming: 0,
          firstSeen: null,
          lastSeen: null,
          createdAt: '',
          updatedAt: '',
        };

    return {
      ...contact,
      emails,
      company,
    };
  }

  /**
   * List contacts with pagination
   */
  async list(
    pagination: ParsedPagination,
    search?: string,
    companyId?: string,
  ): Promise<{ contacts: Contact[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (search !== undefined && search !== '') {
      conditions.push('(name LIKE ? OR id IN (SELECT contact_id FROM emails WHERE email LIKE ?))');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    if (companyId !== undefined) {
      conditions.push('company_id = ?');
      params.push(companyId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM contacts ${whereClause}`;
    const countStmt = this.db.prepare(countQuery);
    const countResult = await (params.length > 0
      ? countStmt.bind(...params)
      : countStmt
    ).first<{ count: number }>();
    const total = countResult?.count ?? 0;

    // Get paginated results
    const query = `
      SELECT * FROM contacts
      ${whereClause}
      ORDER BY ${pagination.sort} ${pagination.order}
      LIMIT ? OFFSET ?
    `;
    const queryParams = [...params, pagination.limit, pagination.offset];
    const result = await this.db
      .prepare(query)
      .bind(...queryParams)
      .all<ContactRow>();

    return {
      contacts: result.results.map((row) => this.rowToContact(row)),
      total,
    };
  }

  /**
   * Create a new contact
   */
  async create(companyId: string, name: string | null): Promise<Contact> {
    const id = generateId();
    const timestamp = now();

    await this.db
      .prepare(
        `INSERT INTO contacts (id, company_id, name, recent_threads, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?)`,
      )
      .bind(id, companyId, name, timestamp, timestamp)
      .run();

    return {
      id,
      companyId,
      name,
      emailsTo: 0,
      emailsFrom: 0,
      emailsIncluded: 0,
      meetingsCompleted: 0,
      meetingsUpcoming: 0,
      recentThreads: [],
      firstSeen: null,
      lastSeen: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Update contact stats and add thread reference
   */
  async updateStatsAndThread(
    id: string,
    stats: {
      emailsTo?: number;
      emailsFrom?: number;
      emailsIncluded?: number;
      lastSeen?: string;
      firstSeen?: string;
    },
    thread?: ThreadReference,
  ): Promise<void> {
    const updates: string[] = [];
    const params: (string | number)[] = [];

    if (stats.emailsTo !== undefined) {
      updates.push('emails_to = emails_to + ?');
      params.push(stats.emailsTo);
    }
    if (stats.emailsFrom !== undefined) {
      updates.push('emails_from = emails_from + ?');
      params.push(stats.emailsFrom);
    }
    if (stats.emailsIncluded !== undefined) {
      updates.push('emails_included = emails_included + ?');
      params.push(stats.emailsIncluded);
    }
    if (stats.lastSeen !== undefined) {
      updates.push('last_seen = MAX(COALESCE(last_seen, ?), ?)');
      params.push(stats.lastSeen, stats.lastSeen);
    }
    if (stats.firstSeen !== undefined) {
      updates.push('first_seen = MIN(COALESCE(first_seen, ?), ?)');
      params.push(stats.firstSeen, stats.firstSeen);
    }

    // Add thread to recent_threads (capped at MAX_THREADS_PER_CONTACT)
    if (thread !== undefined) {
      // Get current threads
      const current = await this.db
        .prepare('SELECT recent_threads FROM contacts WHERE id = ?')
        .bind(id)
        .first<{ recent_threads: string }>();

      if (current !== null) {
        const threads = JSON.parse(current.recent_threads) as ThreadReference[];

        // Add new thread and deduplicate
        const existingIndex = threads.findIndex((t) => t.threadId === thread.threadId);
        if (existingIndex >= 0) {
          threads.splice(existingIndex, 1);
        }
        threads.unshift(thread);

        // Cap at max
        const capped = threads.slice(0, MAX_THREADS_PER_CONTACT);
        updates.push('recent_threads = ?');
        params.push(JSON.stringify(capped));
      }
    }

    if (updates.length === 0) {
      return;
    }

    updates.push('updated_at = ?');
    params.push(now());
    params.push(id);

    await this.db
      .prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  }

  /**
   * Convert database row to Contact entity
   */
  private rowToContact(row: ContactRow): Contact {
    return {
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      emailsTo: row.emails_to,
      emailsFrom: row.emails_from,
      emailsIncluded: row.emails_included,
      meetingsCompleted: row.meetings_completed,
      meetingsUpcoming: row.meetings_upcoming,
      recentThreads: JSON.parse(row.recent_threads) as ThreadReference[],
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
