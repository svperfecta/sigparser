import type { Email, EmailRow, ThreadReference } from '../types/index.js';
import { now } from '../utils/date.js';
import { MAX_THREADS_PER_CONTACT } from '../types/constants.js';

export class EmailRepository {
  constructor(private db: D1Database) {}

  /**
   * Find an email by address
   */
  async findByEmail(email: string): Promise<Email | null> {
    const row = await this.db
      .prepare('SELECT * FROM emails WHERE email = ?')
      .bind(email.toLowerCase())
      .first<EmailRow>();

    if (row === null) {
      return null;
    }

    return this.rowToEmail(row);
  }

  /**
   * Find all emails for a contact
   */
  async findByContactId(contactId: string): Promise<Email[]> {
    const result = await this.db
      .prepare('SELECT * FROM emails WHERE contact_id = ? ORDER BY emails_from DESC')
      .bind(contactId)
      .all<EmailRow>();

    return result.results.map((row) => this.rowToEmail(row));
  }

  /**
   * Create a new email record
   */
  async create(
    email: string,
    contactId: string,
    domain: string,
    nameObserved: string | null,
  ): Promise<Email> {
    const timestamp = now();
    const normalizedEmail = email.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO emails (email, contact_id, domain, name_observed, recent_threads, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?)`,
      )
      .bind(normalizedEmail, contactId, domain.toLowerCase(), nameObserved, timestamp, timestamp)
      .run();

    return {
      email: normalizedEmail,
      contactId,
      domain: domain.toLowerCase(),
      nameObserved,
      isActive: true,
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
   * Find or create an email record
   * Optimized to use INSERT OR IGNORE instead of SELECT-then-INSERT
   */
  async findOrCreate(
    email: string,
    contactId: string,
    domain: string,
    nameObserved: string | null,
  ): Promise<{ email: Email; isNew: boolean }> {
    const timestamp = now();
    const normalizedEmail = email.toLowerCase();

    // INSERT OR IGNORE - will do nothing if email already exists
    const insertResult = await this.db
      .prepare(
        `INSERT OR IGNORE INTO emails (email, contact_id, domain, name_observed, recent_threads, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?)`,
      )
      .bind(normalizedEmail, contactId, domain.toLowerCase(), nameObserved, timestamp, timestamp)
      .run();

    const isNew = insertResult.meta.changes > 0;

    // Fetch the email (whether we just created it or it already existed)
    const row = await this.db
      .prepare('SELECT * FROM emails WHERE email = ?')
      .bind(normalizedEmail)
      .first<EmailRow>();

    if (row === null) {
      throw new Error(`Email ${normalizedEmail} not found after insert`);
    }

    const emailEntity = this.rowToEmail(row);

    // If email existed and we have a new name observation, update it
    if (!isNew && nameObserved !== null && emailEntity.nameObserved === null) {
      await this.db
        .prepare('UPDATE emails SET name_observed = ?, updated_at = ? WHERE email = ?')
        .bind(nameObserved, timestamp, normalizedEmail)
        .run();
      emailEntity.nameObserved = nameObserved;
    }

    return { email: emailEntity, isNew };
  }

  /**
   * Update email stats and add thread reference
   */
  async updateStatsAndThread(
    email: string,
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

    // Add thread to recent_threads
    if (thread !== undefined) {
      const current = await this.db
        .prepare('SELECT recent_threads FROM emails WHERE email = ?')
        .bind(email.toLowerCase())
        .first<{ recent_threads: string }>();

      if (current !== null) {
        const threads = JSON.parse(current.recent_threads) as ThreadReference[];

        const existingIndex = threads.findIndex((t) => t.threadId === thread.threadId);
        if (existingIndex >= 0) {
          threads.splice(existingIndex, 1);
        }
        threads.unshift(thread);

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
    params.push(email.toLowerCase());

    await this.db
      .prepare(`UPDATE emails SET ${updates.join(', ')} WHERE email = ?`)
      .bind(...params)
      .run();
  }

  /**
   * Convert database row to Email entity
   */
  private rowToEmail(row: EmailRow): Email {
    return {
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
    };
  }
}
