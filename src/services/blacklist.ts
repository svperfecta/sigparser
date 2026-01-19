import type { BlacklistEntry, BlacklistRow, BlacklistCategory } from '../types/index.js';
import { PERSONAL_EMAIL_DOMAINS, TRANSACTIONAL_EMAIL_PATTERNS, WHITELISTED_DOMAINS } from '../types/constants.js';
import { extractDomain } from '../utils/email.js';
import { now } from '../utils/date.js';

// Re-export for convenience
export type { BlacklistCategory } from '../types/index.js';

// === Blacklist Service ===

export class BlacklistService {
  private domainCache: Set<string> | null = null;

  constructor(private db: D1Database) {}

  /**
   * Check if an email address should be blacklisted
   */
  async isBlacklisted(email: string): Promise<boolean> {
    // Check transactional patterns first (no DB lookup needed)
    if (this.isTransactional(email)) {
      return true;
    }

    // Extract domain and check against database
    const domain = extractDomain(email);
    if (domain === null) {
      return false;
    }

    return this.isDomainBlacklisted(domain);
  }

  /**
   * Check if an email matches transactional patterns
   */
  isTransactional(email: string): boolean {
    // Check whitelist first - whitelisted domains bypass transactional filters
    const emailLower = email.toLowerCase();
    for (const domain of WHITELISTED_DOMAINS) {
      if (emailLower.includes(`@${domain}`)) {
        return false;
      }
    }

    for (const pattern of TRANSACTIONAL_EMAIL_PATTERNS) {
      if (pattern.test(email)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a domain is in the blacklist
   */
  async isDomainBlacklisted(domain: string): Promise<boolean> {
    // Use cache if available
    if (this.domainCache !== null) {
      return this.domainCache.has(domain.toLowerCase());
    }

    // Query database
    const result = await this.db
      .prepare('SELECT 1 FROM blacklist WHERE domain = ?')
      .bind(domain.toLowerCase())
      .first<{ 1: number }>();

    return result !== null;
  }

  /**
   * Load all blacklisted domains into memory cache
   */
  async loadCache(): Promise<void> {
    const result = await this.db
      .prepare('SELECT domain FROM blacklist')
      .all<{ domain: string }>();

    this.domainCache = new Set(result.results.map((r) => r.domain.toLowerCase()));
  }

  /**
   * Clear the domain cache
   */
  clearCache(): void {
    this.domainCache = null;
  }

  /**
   * Add a domain to the blacklist
   */
  async add(domain: string, category: BlacklistCategory, source?: string): Promise<void> {
    const timestamp = now();
    const normalizedDomain = domain.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO blacklist (domain, category, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           category = excluded.category,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .bind(normalizedDomain, category, source ?? null, timestamp, timestamp)
      .run();

    // Update cache if loaded
    if (this.domainCache !== null) {
      this.domainCache.add(normalizedDomain);
    }
  }

  /**
   * Remove a domain from the blacklist
   */
  async remove(domain: string): Promise<boolean> {
    const normalizedDomain = domain.toLowerCase();

    const result = await this.db
      .prepare('DELETE FROM blacklist WHERE domain = ?')
      .bind(normalizedDomain)
      .run();

    // Update cache if loaded
    if (this.domainCache !== null) {
      this.domainCache.delete(normalizedDomain);
    }

    return result.meta.changes > 0;
  }

  /**
   * List all blacklisted domains, optionally filtered by category
   */
  async list(category?: BlacklistCategory): Promise<BlacklistEntry[]> {
    let query = 'SELECT * FROM blacklist';
    const params: string[] = [];

    if (category !== undefined) {
      query += ' WHERE category = ?';
      params.push(category);
    }

    query += ' ORDER BY domain';

    const stmt = this.db.prepare(query);
    const result = await (params.length > 0 ? stmt.bind(...params) : stmt).all<BlacklistRow>();

    return result.results.map((row) => this.rowToEntry(row));
  }

  /**
   * Get a single blacklist entry by domain
   */
  async get(domain: string): Promise<BlacklistEntry | null> {
    const result = await this.db
      .prepare('SELECT * FROM blacklist WHERE domain = ?')
      .bind(domain.toLowerCase())
      .first<BlacklistRow>();

    if (result === null) {
      return null;
    }

    return this.rowToEntry(result);
  }

  /**
   * Seed the blacklist with personal email domains
   */
  async seedPersonalDomains(): Promise<number> {
    const timestamp = now();
    let count = 0;

    for (const domain of PERSONAL_EMAIL_DOMAINS) {
      try {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO blacklist (domain, category, source, created_at, updated_at)
             VALUES (?, 'personal', 'seed', ?, ?)`,
          )
          .bind(domain, timestamp, timestamp)
          .run();
        count++;
      } catch {
        // Ignore duplicates
      }
    }

    this.clearCache();
    return count;
  }

  /**
   * Import domains from a list
   */
  async importDomains(
    domains: string[],
    category: BlacklistCategory,
    source: string,
  ): Promise<number> {
    const timestamp = now();
    let count = 0;

    // Process in batches
    const batchSize = 100;
    for (let i = 0; i < domains.length; i += batchSize) {
      const batch = domains.slice(i, i + batchSize);

      const statements = batch.map((domain) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO blacklist (domain, category, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(domain.toLowerCase().trim(), category, source, timestamp, timestamp),
      );

      const results = await this.db.batch(statements);
      count += results.filter((r) => r.meta.changes > 0).length;
    }

    this.clearCache();
    return count;
  }

  /**
   * Get count of blacklisted domains by category
   */
  async getCounts(): Promise<Record<BlacklistCategory, number>> {
    const result = await this.db
      .prepare('SELECT category, COUNT(*) as count FROM blacklist GROUP BY category')
      .all<{ category: string; count: number }>();

    const counts: Record<BlacklistCategory, number> = {
      spam: 0,
      personal: 0,
      transactional: 0,
      manual: 0,
    };

    for (const row of result.results) {
      if (row.category in counts) {
        counts[row.category as BlacklistCategory] = row.count;
      }
    }

    return counts;
  }

  /**
   * Convert a database row to a BlacklistEntry
   */
  private rowToEntry(row: BlacklistRow): BlacklistEntry {
    return {
      domain: row.domain,
      category: row.category as BlacklistCategory,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
