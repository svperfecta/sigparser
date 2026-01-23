import type { Company, CompanyRow, CompanyWithDomains, Domain } from '../types/index.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/date.js';
import type { ParsedPagination } from '../utils/pagination.js';

export class CompanyRepository {
  constructor(private db: D1Database) {}

  /**
   * Find a company by ID
   */
  async findById(id: string): Promise<Company | null> {
    const row = await this.db
      .prepare('SELECT * FROM companies WHERE id = ?')
      .bind(id)
      .first<CompanyRow>();

    if (row === null) {
      return null;
    }

    return this.rowToCompany(row);
  }

  /**
   * Find a company by ID with domains and contact count
   */
  async findByIdWithDomains(id: string): Promise<CompanyWithDomains | null> {
    const company = await this.findById(id);
    if (company === null) {
      return null;
    }

    const [domainsResult, countResult] = await Promise.all([
      this.db
        .prepare('SELECT * FROM domains WHERE company_id = ? ORDER BY is_primary DESC, domain')
        .bind(id)
        .all<{
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
        }>(),
      this.db
        .prepare('SELECT COUNT(*) as count FROM contacts WHERE company_id = ?')
        .bind(id)
        .first<{ count: number }>(),
    ]);

    const domains: Domain[] = domainsResult.results.map((row) => ({
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
    }));

    return {
      ...company,
      domains,
      contactCount: countResult?.count ?? 0,
    };
  }

  /**
   * List companies with pagination
   */
  async list(
    pagination: ParsedPagination,
    search?: string,
  ): Promise<{ companies: Company[]; total: number }> {
    let whereClause = '';
    const params: (string | number)[] = [];

    if (search !== undefined && search !== '') {
      whereClause = 'WHERE name LIKE ? OR id IN (SELECT company_id FROM domains WHERE domain LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM companies ${whereClause}`;
    const countStmt = this.db.prepare(countQuery);
    const countResult = await (params.length > 0
      ? countStmt.bind(...params)
      : countStmt
    ).first<{ count: number }>();
    const total = countResult?.count ?? 0;

    // Get paginated results
    const query = `
      SELECT * FROM companies
      ${whereClause}
      ORDER BY ${pagination.sort} ${pagination.order}
      LIMIT ? OFFSET ?
    `;
    const queryParams = [...params, pagination.limit, pagination.offset];
    const result = await this.db
      .prepare(query)
      .bind(...queryParams)
      .all<CompanyRow>();

    return {
      companies: result.results.map((row) => this.rowToCompany(row)),
      total,
    };
  }

  /**
   * Create a new company
   */
  async create(name: string | null): Promise<Company> {
    const id = generateId();
    const timestamp = now();

    await this.db
      .prepare(
        `INSERT INTO companies (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(id, name, timestamp, timestamp)
      .run();

    return {
      id,
      name,
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
   * Find or create a company by domain
   * Optimized to use single JOIN query instead of 2 separate SELECTs
   */
  async findOrCreateByDomain(domain: string): Promise<{ company: Company; isNew: boolean }> {
    // Single query to find company via domain JOIN
    const existing = await this.db
      .prepare(
        `SELECT c.* FROM companies c
         INNER JOIN domains d ON c.id = d.company_id
         WHERE d.domain = ?`,
      )
      .bind(domain)
      .first<CompanyRow>();

    if (existing !== null) {
      return { company: this.rowToCompany(existing), isNew: false };
    }

    // Create new company with domain as name
    const company = await this.create(domain);
    return { company, isNew: true };
  }

  /**
   * Update company stats
   */
  async updateStats(
    id: string,
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
    params.push(id);

    await this.db
      .prepare(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  }

  /**
   * Convert database row to Company entity
   */
  private rowToCompany(row: CompanyRow): Company {
    return {
      id: row.id,
      name: row.name,
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
