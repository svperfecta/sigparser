import { GmailService, getHeader, type GmailMessage } from './gmail.js';
import { BlacklistService } from './blacklist.js';
import { parseEmailHeader, extractDomain, type ParsedEmail } from '../utils/email.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/date.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { SyncStateRow } from '../types/index.js';

// === Types ===

export type AccountType = 'work' | 'personal';

export interface SyncResult {
  messagesProcessed: number;
  contactsCreated: number;
  companiesCreated: number;
  domainsCreated: number;
  emailsCreated: number;
  errors: { messageId: string; error: string }[];
}

export interface SyncConfig {
  gmail: GmailService;
  db: D1Database;
  kv?: KVNamespace;
  myEmail: string;
  account: AccountType;
}

// === Sync Service ===

export class SyncService {
  private blacklist: BlacklistService;
  private logger: Logger;

  constructor(private config: SyncConfig) {
    this.blacklist = new BlacklistService(config.db, config.kv);
    this.logger = createLogger();
  }

  /**
   * Run a batch sync - process one page of messages from the current day
   *
   * Uses a simple pagination model:
   * - Window = 1 day (tracked by batch_current_date)
   * - Page = pageSize messages (tracked by batch_page_token)
   *
   * When all pages for a day are processed, advances to the next day.
   * Progress is saved after each message to survive subrequest limits.
   *
   * @param pageSize Number of messages per page (default 30 - increased after batch DB optimizations)
   */
  async batchSync(pageSize = 30): Promise<SyncResult & { hasMore: boolean; currentDate?: string }> {
    this.logger.info('Starting batch sync', {
      account: this.config.account,
    });

    const result: SyncResult & { hasMore: boolean; currentDate?: string } = {
      messagesProcessed: 0,
      contactsCreated: 0,
      companiesCreated: 0,
      domainsCreated: 0,
      emailsCreated: 0,
      errors: [],
      hasMore: false,
    };

    // Load blacklist into memory for fast lookups
    await this.blacklist.loadCache();

    // Get current history ID first
    const profile = await this.config.gmail.getProfile();

    // Get the current sync progress
    const syncState = await this.getSyncState();

    // Current date being processed (YYYY-MM-DD format)
    // Default to 2000-01-01 (earlier than Gmail's 2004 launch to catch imported emails)
    const currentDate = syncState?.batch_current_date ?? '2000-01-01';
    const today = new Date().toISOString().slice(0, 10);

    // If we've passed today, we're caught up
    if (currentDate > today) {
      this.logger.info('Batch sync complete - caught up to today', {
        account: this.config.account,
        currentDate,
      });
      return result;
    }

    result.currentDate = currentDate;

    // Page token for pagination within this day (null = start from beginning)
    const pageToken = syncState?.batch_page_token ?? undefined;
    // Current page number (0 = haven't started this day yet)
    const currentPageNumber = syncState?.batch_page_number ?? 0;

    // Build Gmail query for this specific day
    // Gmail date format: YYYY/MM/DD
    const [year, month, day] = currentDate.split('-');
    const nextDate = this.addDays(currentDate, 1);
    const [nextYear, nextMonth, nextDay] = nextDate.split('-');
    const query = `after:${year}/${month}/${day} before:${nextYear}/${nextMonth}/${nextDay}`;

    this.logger.info('Batch sync query', {
      query,
      currentDate,
      pageToken: pageToken ?? 'start',
      account: this.config.account,
    });

    // Fetch one page of message IDs
    const listResponse = await this.config.gmail.listMessages({
      maxResults: pageSize,
      pageToken,
      q: query,
    });

    const messageIds = listResponse.messages?.map((m) => m.id) ?? [];

    if (messageIds.length === 0 && pageToken === undefined) {
      // No messages on this date at all, advance to next day
      this.logger.info('No messages on date, advancing to next day', {
        account: this.config.account,
        currentDate,
        nextDate,
      });
      await this.updateSyncStateWithDate(profile.historyId, nextDate, null, 0);
      result.hasMore = nextDate <= today;
      return result;
    }

    if (messageIds.length === 0) {
      // Page token but no messages - shouldn't happen, but handle gracefully
      this.logger.warn('Page token returned no messages, advancing to next day', {
        account: this.config.account,
        currentDate,
      });
      await this.updateSyncStateWithDate(profile.historyId, nextDate, null, 0);
      result.hasMore = nextDate <= today;
      return result;
    }

    // Fetch full message details for this page
    const messages = await this.config.gmail.batchGetMessages(messageIds);

    this.logger.info('Processing page', {
      currentDate,
      pageSize: messages.length,
      hasNextPage: listResponse.nextPageToken !== undefined,
      account: this.config.account,
    });

    // Process each message in this page
    for (const message of messages) {
      // Skip if already processed (in case of retries)
      const isProcessed = await this.isMessageProcessed(message.id);
      if (isProcessed) {
        continue;
      }

      // Mark as processed BEFORE processing (optimistic)
      // If we crash mid-processing, we skip this message on retry
      // This trades perfect accuracy for reliability and fewer DB ops
      await this.markMessageProcessed(message.id);

      try {
        const processed = await this.processMessage(message);
        result.messagesProcessed++;
        result.contactsCreated += processed.contactsCreated;
        result.companiesCreated += processed.companiesCreated;
        result.domainsCreated += processed.domainsCreated;
        result.emailsCreated += processed.emailsCreated;
      } catch (error) {
        result.errors.push({
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update sync state based on whether there are more pages
    const newPageNumber = currentPageNumber + 1;
    if (listResponse.nextPageToken !== undefined) {
      // More pages for this day - save the page token and increment page number
      await this.updateSyncStateWithDate(profile.historyId, currentDate, listResponse.nextPageToken, newPageNumber);
      this.logger.info('Page complete, more pages remain', {
        account: this.config.account,
        currentDate,
        pageNumber: newPageNumber,
        ...result,
      });
    } else {
      // No more pages for this day - advance to next day, reset page number
      await this.updateSyncStateWithDate(profile.historyId, nextDate, null, 0);
      this.logger.info('Day complete, advancing to next day', {
        account: this.config.account,
        completedDate: currentDate,
        pagesProcessed: newPageNumber,
        nextDate,
        ...result,
      });
    }

    // There's more to process if we haven't passed today
    result.hasMore = nextDate <= today || listResponse.nextPageToken !== undefined;

    return result;
  }

  /**
   * Add days to a date string (YYYY-MM-DD format)
   */
  private addDays(dateStr: string, days: number): string {
    const date = new Date(dateStr + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  /**
   * Run a full sync - process all messages in the mailbox
   * WARNING: This can take a very long time for large mailboxes!
   */
  async fullSync(): Promise<SyncResult> {
    this.logger.info('Starting full sync', { account: this.config.account });

    const result: SyncResult = {
      messagesProcessed: 0,
      contactsCreated: 0,
      companiesCreated: 0,
      domainsCreated: 0,
      emailsCreated: 0,
      errors: [],
    };

    // Load blacklist into memory for fast lookups
    await this.blacklist.loadCache();

    // Get current history ID first
    const profile = await this.config.gmail.getProfile();

    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount++;
      this.logger.info('Processing page', { page: pageCount, account: this.config.account });

      // List messages
      const listResponse = await this.config.gmail.listMessages({
        pageToken,
        maxResults: 100,
      });

      if (listResponse.messages === undefined || listResponse.messages.length === 0) {
        break;
      }

      // Batch fetch message metadata
      const messageIds = listResponse.messages.map((m) => m.id);
      const messages = await this.config.gmail.batchGetMessages(messageIds);

      // Process each message
      for (const message of messages) {
        try {
          const processed = await this.processMessage(message);
          result.messagesProcessed++;
          result.contactsCreated += processed.contactsCreated;
          result.companiesCreated += processed.companiesCreated;
          result.domainsCreated += processed.domainsCreated;
          result.emailsCreated += processed.emailsCreated;
        } catch (error) {
          result.errors.push({
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      pageToken = listResponse.nextPageToken;

      // Log progress
      if (pageCount % 10 === 0) {
        this.logger.info('Sync progress', {
          pages: pageCount,
          messagesProcessed: result.messagesProcessed,
          account: this.config.account,
        });
      }
    } while (pageToken !== undefined);

    // Update sync state
    await this.updateSyncState(profile.historyId);

    this.logger.info('Full sync complete', {
      account: this.config.account,
      ...result,
    });

    return result;
  }

  /**
   * Run an incremental sync using Gmail history API
   */
  async incrementalSync(): Promise<SyncResult> {
    this.logger.info('Starting incremental sync', { account: this.config.account });

    const result: SyncResult = {
      messagesProcessed: 0,
      contactsCreated: 0,
      companiesCreated: 0,
      domainsCreated: 0,
      emailsCreated: 0,
      errors: [],
    };

    // Get last sync state
    const syncState = await this.getSyncState();
    if (syncState?.last_history_id === null || syncState?.last_history_id === undefined) {
      this.logger.info('No previous sync state, running full sync');
      return this.fullSync();
    }

    // Load blacklist
    await this.blacklist.loadCache();

    let pageToken: string | undefined;
    let latestHistoryId = syncState.last_history_id;

    try {
      do {
        const historyResponse = await this.config.gmail.getHistory({
          startHistoryId: syncState.last_history_id,
          pageToken,
        });

        latestHistoryId = historyResponse.historyId;

        if (historyResponse.history !== undefined) {
          for (const record of historyResponse.history) {
            if (record.messagesAdded !== undefined) {
              for (const added of record.messagesAdded) {
                try {
                  // Check if already processed
                  const isProcessed = await this.isMessageProcessed(added.message.id);
                  if (isProcessed) {
                    continue;
                  }

                  const processed = await this.processMessage(added.message);
                  result.messagesProcessed++;
                  result.contactsCreated += processed.contactsCreated;
                  result.companiesCreated += processed.companiesCreated;
                  result.domainsCreated += processed.domainsCreated;
                  result.emailsCreated += processed.emailsCreated;

                  await this.markMessageProcessed(added.message.id);
                } catch (error) {
                  result.errors.push({
                    messageId: added.message.id,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
          }
        }

        pageToken = historyResponse.nextPageToken;
      } while (pageToken !== undefined);
    } catch (error) {
      // History ID might be expired, fall back to full sync
      if (error instanceof Error && error.message.includes('404')) {
        this.logger.warn('History expired, running full sync');
        return this.fullSync();
      }
      throw error;
    }

    // Update sync state
    await this.updateSyncState(latestHistoryId);

    this.logger.info('Incremental sync complete', {
      account: this.config.account,
      ...result,
    });

    return result;
  }

  /**
   * Process a single Gmail message using batched DB operations
   * This dramatically reduces query count from ~8 per email to ~6 total per message
   */
  private async processMessage(message: GmailMessage): Promise<{
    contactsCreated: number;
    companiesCreated: number;
    domainsCreated: number;
    emailsCreated: number;
  }> {
    const stats = {
      contactsCreated: 0,
      companiesCreated: 0,
      domainsCreated: 0,
      emailsCreated: 0,
    };

    // Extract headers
    const from = getHeader(message, 'From');
    const to = getHeader(message, 'To');
    const cc = getHeader(message, 'Cc');
    const dateStr = getHeader(message, 'Date');

    // Parse date
    let messageDate: string;
    if (dateStr !== null) {
      try {
        messageDate = new Date(dateStr).toISOString();
      } catch {
        messageDate = new Date(parseInt(message.internalDate, 10)).toISOString();
      }
    } else {
      messageDate = new Date(parseInt(message.internalDate, 10)).toISOString();
    }

    // Parse all email addresses
    const allEmails: (ParsedEmail & { role: 'from' | 'to' | 'cc' })[] = [];

    if (from !== null) {
      for (const parsed of parseEmailHeader(from)) {
        allEmails.push({ ...parsed, role: 'from' });
      }
    }
    if (to !== null) {
      for (const parsed of parseEmailHeader(to)) {
        allEmails.push({ ...parsed, role: 'to' });
      }
    }
    if (cc !== null) {
      for (const parsed of parseEmailHeader(cc)) {
        allEmails.push({ ...parsed, role: 'cc' });
      }
    }

    // Determine if this is sent or received
    const myEmailLower = this.config.myEmail.toLowerCase();
    const fromMe = allEmails.some((e) => e.role === 'from' && e.email === myEmailLower);

    // Filter out self and blacklisted emails
    const validEmails: (ParsedEmail & { role: 'from' | 'to' | 'cc' })[] = [];
    for (const parsed of allEmails) {
      if (parsed.email === myEmailLower) {
        continue;
      }
      const isBlacklisted = await this.blacklist.isBlacklisted(parsed.email);
      if (!isBlacklisted) {
        validEmails.push(parsed);
      }
    }

    if (validEmails.length === 0) {
      return stats;
    }

    // Collect unique domains and emails
    const uniqueDomains = [...new Set(validEmails.map((e) => e.domain))];
    const uniqueEmailAddresses = [...new Set(validEmails.map((e) => e.email))];

    // PHASE 1: Batch lookup existing domains and emails
    const [existingDomainsResult, existingEmailsResult] = await Promise.all([
      uniqueDomains.length > 0
        ? this.config.db
            .prepare(
              `SELECT domain, company_id FROM domains WHERE domain IN (${uniqueDomains.map(() => '?').join(',')})`,
            )
            .bind(...uniqueDomains)
            .all<{ domain: string; company_id: string }>()
        : Promise.resolve({ results: [] as { domain: string; company_id: string }[] }),
      uniqueEmailAddresses.length > 0
        ? this.config.db
            .prepare(
              `SELECT e.email, e.contact_id, c.name as contact_name, c.company_id
               FROM emails e JOIN contacts c ON e.contact_id = c.id
               WHERE e.email IN (${uniqueEmailAddresses.map(() => '?').join(',')})`,
            )
            .bind(...uniqueEmailAddresses)
            .all<{ email: string; contact_id: string; contact_name: string | null; company_id: string }>()
        : Promise.resolve({ results: [] as { email: string; contact_id: string; contact_name: string | null; company_id: string }[] }),
    ]);

    // Build lookup maps
    const domainToCompanyId = new Map<string, string>();
    for (const row of existingDomainsResult.results) {
      domainToCompanyId.set(row.domain, row.company_id);
    }

    const emailToContact = new Map<string, { contactId: string; contactName: string | null; companyId: string }>();
    for (const row of existingEmailsResult.results) {
      emailToContact.set(row.email, {
        contactId: row.contact_id,
        contactName: row.contact_name,
        companyId: row.company_id,
      });
    }

    // PHASE 2: Prepare inserts for new domains/companies
    const timestamp = now();
    const insertStatements: D1PreparedStatement[] = [];

    // Track new companies and domains to insert
    const newCompanies: { id: string; domain: string }[] = [];
    for (const domain of uniqueDomains) {
      if (!domainToCompanyId.has(domain)) {
        const companyId = generateId();
        newCompanies.push({ id: companyId, domain });
        domainToCompanyId.set(domain, companyId);
      }
    }

    // Batch insert new companies
    if (newCompanies.length > 0) {
      for (const company of newCompanies) {
        insertStatements.push(
          this.config.db
            .prepare(
              'INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
            )
            .bind(company.id, company.domain, timestamp, timestamp),
        );
        insertStatements.push(
          this.config.db
            .prepare(
              'INSERT INTO domains (domain, company_id, is_primary, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
            )
            .bind(company.domain, company.id, timestamp, timestamp),
        );
        stats.companiesCreated++;
        stats.domainsCreated++;
      }
    }

    // PHASE 3: Prepare inserts for new contacts/emails
    const newContacts: { id: string; companyId: string; name: string | null; email: string }[] = [];
    for (const emailAddr of uniqueEmailAddresses) {
      if (!emailToContact.has(emailAddr)) {
        const parsed = validEmails.find((e) => e.email === emailAddr);
        if (parsed !== undefined) {
          const companyId = domainToCompanyId.get(parsed.domain);
          if (companyId !== undefined) {
            const contactId = generateId();
            newContacts.push({ id: contactId, companyId, name: parsed.name, email: emailAddr });
            emailToContact.set(emailAddr, { contactId, contactName: parsed.name, companyId });
          }
        }
      }
    }

    // Batch insert new contacts and emails
    if (newContacts.length > 0) {
      for (const contact of newContacts) {
        insertStatements.push(
          this.config.db
            .prepare(
              'INSERT INTO contacts (id, company_id, name, recent_threads, created_at, updated_at) VALUES (?, ?, ?, \'[]\', ?, ?)',
            )
            .bind(contact.id, contact.companyId, contact.name, timestamp, timestamp),
        );
        insertStatements.push(
          this.config.db
            .prepare(
              'INSERT INTO emails (email, contact_id, domain, name_observed, recent_threads, created_at, updated_at) VALUES (?, ?, ?, ?, \'[]\', ?, ?)',
            )
            .bind(contact.email, contact.id, extractDomain(contact.email), contact.name, timestamp, timestamp),
        );
        stats.contactsCreated++;
        stats.emailsCreated++;
      }
    }

    // Execute all inserts in a single batch
    if (insertStatements.length > 0) {
      await this.config.db.batch(insertStatements);
    }

    // PHASE 4: Batch update stats
    // Aggregate stats per entity
    const companyStats = new Map<string, { emailsTo: number; emailsFrom: number; emailsIncluded: number }>();
    const domainStats = new Map<string, { emailsTo: number; emailsFrom: number; emailsIncluded: number }>();
    const contactStats = new Map<string, { emailsTo: number; emailsFrom: number; emailsIncluded: number }>();
    const emailStats = new Map<string, { emailsTo: number; emailsFrom: number; emailsIncluded: number }>();
    const contactNameUpdates: { contactId: string; name: string }[] = [];

    for (const parsed of validEmails) {
      const companyId = domainToCompanyId.get(parsed.domain);
      const contactInfo = emailToContact.get(parsed.email);

      if (companyId === undefined || contactInfo === undefined) {
        continue;
      }

      const isFrom = parsed.role === 'from';
      const isTo = parsed.role === 'to';
      const isIncluded = parsed.role === 'cc';

      const delta = {
        emailsTo: fromMe && isTo ? 1 : 0,
        emailsFrom: !fromMe && isFrom ? 1 : 0,
        emailsIncluded: isIncluded ? 1 : 0,
      };

      // Aggregate company stats
      const cs = companyStats.get(companyId) ?? { emailsTo: 0, emailsFrom: 0, emailsIncluded: 0 };
      cs.emailsTo += delta.emailsTo;
      cs.emailsFrom += delta.emailsFrom;
      cs.emailsIncluded += delta.emailsIncluded;
      companyStats.set(companyId, cs);

      // Aggregate domain stats
      const ds = domainStats.get(parsed.domain) ?? { emailsTo: 0, emailsFrom: 0, emailsIncluded: 0 };
      ds.emailsTo += delta.emailsTo;
      ds.emailsFrom += delta.emailsFrom;
      ds.emailsIncluded += delta.emailsIncluded;
      domainStats.set(parsed.domain, ds);

      // Aggregate contact stats
      const cts = contactStats.get(contactInfo.contactId) ?? { emailsTo: 0, emailsFrom: 0, emailsIncluded: 0 };
      cts.emailsTo += delta.emailsTo;
      cts.emailsFrom += delta.emailsFrom;
      cts.emailsIncluded += delta.emailsIncluded;
      contactStats.set(contactInfo.contactId, cts);

      // Aggregate email stats
      const es = emailStats.get(parsed.email) ?? { emailsTo: 0, emailsFrom: 0, emailsIncluded: 0 };
      es.emailsTo += delta.emailsTo;
      es.emailsFrom += delta.emailsFrom;
      es.emailsIncluded += delta.emailsIncluded;
      emailStats.set(parsed.email, es);

      // Track contact name updates
      if (parsed.name !== null && contactInfo.contactName === null) {
        contactNameUpdates.push({ contactId: contactInfo.contactId, name: parsed.name });
      }
    }

    // Build batch update statements
    const updateStatements: D1PreparedStatement[] = [];

    for (const [companyId, s] of companyStats) {
      updateStatements.push(
        this.config.db
          .prepare(
            `UPDATE companies SET
              emails_to = emails_to + ?,
              emails_from = emails_from + ?,
              emails_included = emails_included + ?,
              last_seen = MAX(COALESCE(last_seen, ?), ?),
              first_seen = MIN(COALESCE(first_seen, ?), ?),
              updated_at = ?
            WHERE id = ?`,
          )
          .bind(s.emailsTo, s.emailsFrom, s.emailsIncluded, messageDate, messageDate, messageDate, messageDate, timestamp, companyId),
      );
    }

    for (const [domain, s] of domainStats) {
      updateStatements.push(
        this.config.db
          .prepare(
            `UPDATE domains SET
              emails_to = emails_to + ?,
              emails_from = emails_from + ?,
              emails_included = emails_included + ?,
              last_seen = MAX(COALESCE(last_seen, ?), ?),
              first_seen = MIN(COALESCE(first_seen, ?), ?),
              updated_at = ?
            WHERE domain = ?`,
          )
          .bind(s.emailsTo, s.emailsFrom, s.emailsIncluded, messageDate, messageDate, messageDate, messageDate, timestamp, domain),
      );
    }

    for (const [contactId, s] of contactStats) {
      updateStatements.push(
        this.config.db
          .prepare(
            `UPDATE contacts SET
              emails_to = emails_to + ?,
              emails_from = emails_from + ?,
              emails_included = emails_included + ?,
              last_seen = MAX(COALESCE(last_seen, ?), ?),
              first_seen = MIN(COALESCE(first_seen, ?), ?),
              updated_at = ?
            WHERE id = ?`,
          )
          .bind(s.emailsTo, s.emailsFrom, s.emailsIncluded, messageDate, messageDate, messageDate, messageDate, timestamp, contactId),
      );
    }

    for (const [email, s] of emailStats) {
      updateStatements.push(
        this.config.db
          .prepare(
            `UPDATE emails SET
              emails_to = emails_to + ?,
              emails_from = emails_from + ?,
              emails_included = emails_included + ?,
              last_seen = MAX(COALESCE(last_seen, ?), ?),
              first_seen = MIN(COALESCE(first_seen, ?), ?),
              updated_at = ?
            WHERE email = ?`,
          )
          .bind(s.emailsTo, s.emailsFrom, s.emailsIncluded, messageDate, messageDate, messageDate, messageDate, timestamp, email),
      );
    }

    // Add contact name updates
    for (const update of contactNameUpdates) {
      updateStatements.push(
        this.config.db
          .prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ? AND name IS NULL')
          .bind(update.name, timestamp, update.contactId),
      );
    }

    // Execute all updates in a single batch
    if (updateStatements.length > 0) {
      await this.config.db.batch(updateStatements);
    }

    return stats;
  }

  /**
   * Get current sync state
   */
  private async getSyncState(): Promise<SyncStateRow | null> {
    return this.config.db
      .prepare('SELECT * FROM sync_state WHERE account = ?')
      .bind(this.config.account)
      .first<SyncStateRow>();
  }

  /**
   * Update sync state (legacy date-based)
   */
  private async updateSyncState(historyId: string, batchCurrentDate?: string): Promise<void> {
    const timestamp = now();

    if (batchCurrentDate !== undefined) {
      await this.config.db
        .prepare(
          `INSERT INTO sync_state (account, last_history_id, last_sync, batch_current_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET
             last_history_id = excluded.last_history_id,
             last_sync = excluded.last_sync,
             batch_current_date = excluded.batch_current_date,
             updated_at = excluded.updated_at`,
        )
        .bind(this.config.account, historyId, timestamp, batchCurrentDate, timestamp, timestamp)
        .run();
    } else {
      await this.config.db
        .prepare(
          `INSERT INTO sync_state (account, last_history_id, last_sync, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET
             last_history_id = excluded.last_history_id,
             last_sync = excluded.last_sync,
             updated_at = excluded.updated_at`,
        )
        .bind(this.config.account, historyId, timestamp, timestamp, timestamp)
        .run();
    }
  }

  /**
   * Update sync state with date + page token tracking
   * @param historyId - Gmail history ID for incremental sync
   * @param batchCurrentDate - Current date being processed (YYYY-MM-DD)
   * @param batchPageToken - Gmail page token for current position in the day (null = start of day)
   * @param batchPageNumber - Page number within current day (0 = starting fresh)
   */
  private async updateSyncStateWithDate(
    historyId: string,
    batchCurrentDate: string,
    batchPageToken: string | null,
    batchPageNumber: number,
  ): Promise<void> {
    const timestamp = now();

    await this.config.db
      .prepare(
        `INSERT INTO sync_state (account, last_history_id, last_sync, batch_current_date, batch_page_token, batch_page_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET
           last_history_id = excluded.last_history_id,
           last_sync = excluded.last_sync,
           batch_current_date = excluded.batch_current_date,
           batch_page_token = excluded.batch_page_token,
           batch_page_number = excluded.batch_page_number,
           updated_at = excluded.updated_at`,
      )
      .bind(this.config.account, historyId, timestamp, batchCurrentDate, batchPageToken, batchPageNumber, timestamp, timestamp)
      .run();
  }

  /**
   * Check if a message has already been processed
   */
  private async isMessageProcessed(messageId: string): Promise<boolean> {
    const result = await this.config.db
      .prepare('SELECT 1 FROM processed_messages WHERE message_id = ?')
      .bind(messageId)
      .first<{ 1: number }>();

    return result !== null;
  }

  /**
   * Mark a message as processed
   */
  private async markMessageProcessed(messageId: string): Promise<void> {
    await this.config.db
      .prepare(
        'INSERT OR IGNORE INTO processed_messages (message_id, account, processed_at) VALUES (?, ?, ?)',
      )
      .bind(messageId, this.config.account, now())
      .run();
  }
}

/**
 * Get sync status for all accounts
 */
export async function getSyncStatus(
  db: D1Database,
): Promise<{
  account: AccountType;
  lastSync: string | null;
  lastHistoryId: string | null;
  batchCurrentDate: string | null;
  batchPageToken: string | null;
  batchPageNumber: number;
}[]> {
  const result = await db
    .prepare(
      'SELECT account, last_sync, last_history_id, batch_current_date, batch_page_token, batch_page_number FROM sync_state',
    )
    .all<{
      account: string;
      last_sync: string | null;
      last_history_id: string | null;
      batch_current_date: string | null;
      batch_page_token: string | null;
      batch_page_number: number | null;
    }>();

  const accounts: AccountType[] = ['work', 'personal'];
  const status = accounts.map((account) => {
    const row = result.results.find((r) => r.account === account);
    return {
      account,
      lastSync: row?.last_sync ?? null,
      lastHistoryId: row?.last_history_id ?? null,
      batchCurrentDate: row?.batch_current_date ?? null,
      batchPageToken: row?.batch_page_token ?? null,
      batchPageNumber: row?.batch_page_number ?? 0,
    };
  });

  return status;
}
