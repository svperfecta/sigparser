import { GmailService, getHeader, type GmailMessage } from './gmail.js';
import { BlacklistService } from './blacklist.js';
import { CompanyRepository } from '../repositories/company.js';
import { DomainRepository } from '../repositories/domain.js';
import { ContactRepository } from '../repositories/contact.js';
import { EmailRepository } from '../repositories/email.js';
import { parseEmailHeader, type ParsedEmail } from '../utils/email.js';
import { now } from '../utils/date.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { SyncStateRow, ThreadReference } from '../types/index.js';

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
  myEmail: string;
  account: AccountType;
}

// === Sync Service ===

export class SyncService {
  private blacklist: BlacklistService;
  private companies: CompanyRepository;
  private domains: DomainRepository;
  private contacts: ContactRepository;
  private emails: EmailRepository;
  private logger: Logger;

  constructor(private config: SyncConfig) {
    this.blacklist = new BlacklistService(config.db);
    this.companies = new CompanyRepository(config.db);
    this.domains = new DomainRepository(config.db);
    this.contacts = new ContactRepository(config.db);
    this.emails = new EmailRepository(config.db);
    this.logger = createLogger();
  }

  /**
   * Run a batch sync - process messages one day at a time, oldest first
   * This is designed to be called repeatedly by cron until all messages are synced
   *
   * @param maxMessages Maximum messages to process per batch (default 25 to stay under subrequest limits)
   */
  async batchSync(maxMessages = 25): Promise<SyncResult & { hasMore: boolean; currentDate?: string }> {
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

    // Determine the current date to process (YYYY-MM-DD format)
    // Default start is 2000-01-01 (earlier than Gmail's 2004 launch to catch imported emails)
    const currentDate = syncState?.batch_current_date ?? '2000-01-01';
    const today = new Date().toISOString().slice(0, 10);

    // If we've caught up to today, we're done with batch sync
    if (currentDate > today) {
      this.logger.info('Batch sync complete - caught up to today', {
        account: this.config.account,
      });
      return result;
    }

    // Parse current date and build Gmail query
    // Gmail uses YYYY/MM/DD format for after/before
    const [year, month, day] = currentDate.split('-');
    const nextDate = this.addDays(currentDate, 1);
    const [nextYear, nextMonth, nextDay] = nextDate.split('-');

    const query = `after:${year}/${month}/${day} before:${nextYear}/${nextMonth}/${nextDay}`;

    this.logger.info('Batch sync query', { query, currentDate, nextDate });

    result.currentDate = currentDate;

    // Get ALL message IDs for this day (just IDs - lightweight)
    let pageToken: string | undefined;
    let allMessageIds: string[] = [];

    do {
      const listResponse = await this.config.gmail.listMessages({
        pageToken,
        maxResults: 100,
        q: query,
      });

      if (listResponse.messages !== undefined && listResponse.messages.length > 0) {
        allMessageIds = allMessageIds.concat(listResponse.messages.map((m) => m.id));
      }

      pageToken = listResponse.nextPageToken;
    } while (pageToken !== undefined);

    if (allMessageIds.length === 0) {
      // No messages on this date, advance to next day
      this.logger.info('No messages on date, advancing', {
        account: this.config.account,
        fromDate: currentDate,
        toDate: nextDate,
      });
      await this.updateSyncState(profile.historyId, nextDate);
      result.hasMore = nextDate <= today;
      return result;
    }

    // Filter out already-processed messages
    const unprocessedIds: string[] = [];
    for (const id of allMessageIds) {
      const isProcessed = await this.isMessageProcessed(id);
      if (!isProcessed) {
        unprocessedIds.push(id);
      }
    }

    if (unprocessedIds.length === 0) {
      // All messages for this day already processed, advance to next day
      this.logger.info('All messages processed for date, advancing', {
        account: this.config.account,
        fromDate: currentDate,
        toDate: nextDate,
        totalMessages: allMessageIds.length,
      });
      await this.updateSyncState(profile.historyId, nextDate);
      result.hasMore = nextDate <= today;
      return result;
    }

    // Take only up to maxMessages unprocessed IDs for this batch
    const batchIds = unprocessedIds.slice(0, maxMessages);
    const hasMoreMessagesToday = unprocessedIds.length > maxMessages;

    this.logger.info('Fetching messages for date', {
      totalForDay: allMessageIds.length,
      unprocessed: unprocessedIds.length,
      batchSize: batchIds.length,
      date: currentDate,
      hasMoreToday: hasMoreMessagesToday,
      account: this.config.account,
    });

    // Fetch message metadata for this batch
    const messages = await this.config.gmail.batchGetMessages(batchIds);

    // Sort by internal date (oldest first within the day)
    messages.sort((a, b) => {
      const dateA = parseInt(a.internalDate ?? '0', 10);
      const dateB = parseInt(b.internalDate ?? '0', 10);
      return dateA - dateB;
    });

    // Process each message
    for (const message of messages) {
      // Skip if already processed
      const alreadyProcessed = await this.isMessageProcessed(message.id);
      if (alreadyProcessed) {
        continue;
      }

      try {
        const processed = await this.processMessage(message);
        result.messagesProcessed++;
        result.contactsCreated += processed.contactsCreated;
        result.companiesCreated += processed.companiesCreated;
        result.domainsCreated += processed.domainsCreated;
        result.emailsCreated += processed.emailsCreated;

        // Mark as processed
        await this.markMessageProcessed(message.id);
      } catch (error) {
        result.errors.push({
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Log progress every 100 messages
      if (result.messagesProcessed % 100 === 0) {
        this.logger.info('Batch sync progress', {
          processed: result.messagesProcessed,
          total: messages.length,
          date: currentDate,
          account: this.config.account,
        });
      }
    }

    // Only advance to next day if we've processed all messages for today
    if (!hasMoreMessagesToday) {
      await this.updateSyncState(profile.historyId, nextDate);
      this.logger.info('Batch sync complete for date', {
        account: this.config.account,
        date: currentDate,
        nextDate,
        ...result,
      });
    } else {
      // More messages today, don't advance
      await this.updateSyncState(profile.historyId, currentDate);
      this.logger.info('Batch sync progress for date', {
        account: this.config.account,
        date: currentDate,
        hasMoreToday: true,
        ...result,
      });
    }

    // There's more to process
    result.hasMore = hasMoreMessagesToday || nextDate <= today;

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
   * Process a single Gmail message
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

    // Create thread reference
    const thread: ThreadReference = {
      threadId: message.threadId,
      account: this.config.account,
      timestamp: messageDate,
    };

    // Process each email address (excluding self)
    for (const parsed of allEmails) {
      if (parsed.email === myEmailLower) {
        continue;
      }

      // Check blacklist
      const isBlacklisted = await this.blacklist.isBlacklisted(parsed.email);
      if (isBlacklisted) {
        continue;
      }

      // Determine stat type
      const isFrom = parsed.role === 'from';
      const isTo = parsed.role === 'to';
      const isIncluded = parsed.role === 'cc';

      const statUpdate = {
        emailsTo: fromMe && isTo ? 1 : 0,
        emailsFrom: !fromMe && isFrom ? 1 : 0,
        emailsIncluded: isIncluded ? 1 : 0,
        lastSeen: messageDate,
        firstSeen: messageDate,
      };

      // Find or create company and domain
      const { company, isNew: companyIsNew } = await this.companies.findOrCreateByDomain(
        parsed.domain,
      );
      if (companyIsNew) {
        stats.companiesCreated++;
      }

      const { domain, isNew: domainIsNew } = await this.domains.findOrCreate(
        parsed.domain,
        company.id,
      );
      if (domainIsNew) {
        stats.domainsCreated++;
      }

      // Find or create contact - look for existing email first
      let contact = await this.findContactByEmail(parsed.email);
      let contactIsNew = false;

      if (contact === null) {
        contact = await this.contacts.create(company.id, parsed.name);
        contactIsNew = true;
        stats.contactsCreated++;
      }

      // Find or create email record
      const { email: emailRecord, isNew: emailIsNew } = await this.emails.findOrCreate(
        parsed.email,
        contact.id,
        parsed.domain,
        parsed.name,
      );
      if (emailIsNew) {
        stats.emailsCreated++;
      }

      // Update stats at all levels
      await Promise.all([
        this.companies.updateStats(company.id, statUpdate),
        this.domains.updateStats(domain.domain, statUpdate),
        this.contacts.updateStatsAndThread(contact.id, statUpdate, thread),
        this.emails.updateStatsAndThread(emailRecord.email, statUpdate, thread),
      ]);

      // Update contact name if we got a better one
      if (!contactIsNew && parsed.name !== null && contact.name === null) {
        await this.config.db
          .prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?')
          .bind(parsed.name, now(), contact.id)
          .run();
      }
    }

    return stats;
  }

  /**
   * Find a contact by email address
   */
  private async findContactByEmail(email: string): Promise<{ id: string; name: string | null } | null> {
    const result = await this.config.db
      .prepare('SELECT c.id, c.name FROM contacts c JOIN emails e ON c.id = e.contact_id WHERE e.email = ?')
      .bind(email.toLowerCase())
      .first<{ id: string; name: string | null }>();

    return result;
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
   * Update sync state
   * @param historyId - Gmail history ID for incremental sync
   * @param batchCurrentDate - Current date being processed in batch sync (YYYY-MM-DD format)
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
}[]> {
  const result = await db
    .prepare('SELECT account, last_sync, last_history_id, batch_current_date FROM sync_state')
    .all<{
      account: string;
      last_sync: string | null;
      last_history_id: string | null;
      batch_current_date: string | null;
    }>();

  const accounts: AccountType[] = ['work', 'personal'];
  const status = accounts.map((account) => {
    const row = result.results.find((r) => r.account === account);
    return {
      account,
      lastSync: row?.last_sync ?? null,
      lastHistoryId: row?.last_history_id ?? null,
      batchCurrentDate: row?.batch_current_date ?? null,
    };
  });

  return status;
}
