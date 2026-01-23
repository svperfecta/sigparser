import type { Domain } from '../types/index.js';
import { now } from '../utils/date.js';

interface DomainRow {
  domain: string;
  company_id: string;
  is_primary: number;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  meetings_completed: number;
  meetings_upcoming: number;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export class DomainRepository {
  constructor(private db: D1Database) {}

  /**
   * Find a domain by name
   */
  async findByDomain(domain: string): Promise<Domain | null> {
    const row = await this.db
      .prepare('SELECT * FROM domains WHERE domain = ?')
      .bind(domain.toLowerCase())
      .first<DomainRow>();

    if (row === null) {
      return null;
    }

    return this.rowToDomain(row);
  }

  /**
   * Find all domains for a company
   */
  async findByCompanyId(companyId: string): Promise<Domain[]> {
    const result = await this.db
      .prepare('SELECT * FROM domains WHERE company_id = ? ORDER BY is_primary DESC, domain')
      .bind(companyId)
      .all<DomainRow>();

    return result.results.map((row) => this.rowToDomain(row));
  }

  /**
   * Create a new domain
   */
  async create(domain: string, companyId: string, isPrimary = false): Promise<Domain> {
    const timestamp = now();
    const normalizedDomain = domain.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO domains (domain, company_id, is_primary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(normalizedDomain, companyId, isPrimary ? 1 : 0, timestamp, timestamp)
      .run();

    return {
      domain: normalizedDomain,
      companyId,
      isPrimary,
      emailsTo: 0,
      emailsFrom: 0,
      emailsIncluded: 0,
      meetingsCompleted: 0,
      meetingsUpcoming: 0,
      firstSeen: null,
      lastSeen: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Find or create a domain
   * Optimized to use INSERT OR IGNORE instead of SELECT-then-INSERT
   */
  async findOrCreate(domain: string, companyId: string): Promise<{ domain: Domain; isNew: boolean }> {
    const timestamp = now();
    const normalizedDomain = domain.toLowerCase();

    // INSERT OR IGNORE - will do nothing if domain already exists
    const insertResult = await this.db
      .prepare(
        `INSERT OR IGNORE INTO domains (domain, company_id, is_primary, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .bind(normalizedDomain, companyId, timestamp, timestamp)
      .run();

    const isNew = insertResult.meta.changes > 0;

    // Fetch the domain (whether we just created it or it already existed)
    const row = await this.db
      .prepare('SELECT * FROM domains WHERE domain = ?')
      .bind(normalizedDomain)
      .first<DomainRow>();

    // Should never be null at this point, but handle gracefully
    if (row === null) {
      throw new Error(`Domain ${normalizedDomain} not found after insert`);
    }

    return { domain: this.rowToDomain(row), isNew };
  }

  /**
   * Update domain stats
   */
  async updateStats(
    domain: string,
    stats: {
      emailsTo?: number;
      emailsFrom?: number;
      emailsIncluded?: number;
      lastSeen?: string;
      firstSeen?: string;
    },
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

    if (updates.length === 0) {
      return;
    }

    updates.push('updated_at = ?');
    params.push(now());
    params.push(domain.toLowerCase());

    await this.db
      .prepare(`UPDATE domains SET ${updates.join(', ')} WHERE domain = ?`)
      .bind(...params)
      .run();
  }

  /**
   * Convert database row to Domain entity
   */
  private rowToDomain(row: DomainRow): Domain {
    return {
      domain: row.domain,
      companyId: row.company_id,
      isPrimary: row.is_primary === 1,
      emailsTo: row.emails_to,
      emailsFrom: row.emails_from,
      emailsIncluded: row.emails_included,
      meetingsCompleted: row.meetings_completed,
      meetingsUpcoming: row.meetings_upcoming,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
