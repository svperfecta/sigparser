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
   * Run a batch sync - process messages using timestamp-based queries
   * Uses Unix timestamps for precise time-window queries to Gmail
   *
   * @param maxMessages Maximum messages to process per batch (default 25 to stay under subrequest limits)
   */
  async batchSync(maxMessages = 25): Promise<SyncResult & { hasMore: boolean; lastTimestamp?: number }> {
    this.logger.info('Starting batch sync', {
      account: this.config.account,
    });

    const result: SyncResult & { hasMore: boolean; lastTimestamp?: number } = {
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

    // Default start: Jan 1, 2000 (946684800 Unix timestamp)
    // This is earlier than Gmail's 2004 launch to catch imported emails
    const DEFAULT_START_TIMESTAMP = 946684800;
    const startTimestamp = syncState?.batch_last_timestamp ?? DEFAULT_START_TIMESTAMP;
    const nowTimestamp = Math.floor(Date.now() / 1000);

    // If we've caught up to within the last hour, we're done with batch sync
    if (startTimestamp >= nowTimestamp - 3600) {
      this.logger.info('Batch sync complete - caught up to now', {
        account: this.config.account,
        lastTimestamp: startTimestamp,
      });
      return result;
    }

    // Query with Unix timestamps - get messages after our last processed timestamp
    // Gmail returns newest first, so we'll get messages and sort them
    const query = `after:${startTimestamp}`;

    this.logger.info('Batch sync query', {
      query,
      startTimestamp,
      startDate: new Date(startTimestamp * 1000).toISOString(),
      account: this.config.account,
    });

    // Get up to maxMessages * 2 to have some buffer for filtering
    const listResponse = await this.config.gmail.listMessages({
      maxResults: maxMessages * 2,
      q: query,
    });

    const messageIds = listResponse.messages?.map((m) => m.id) ?? [];

    if (messageIds.length === 0) {
      // No messages found, we're caught up
      this.logger.info('No messages found, caught up', {
        account: this.config.account,
        lastTimestamp: startTimestamp,
      });
      await this.updateSyncStateWithTimestamp(profile.historyId, nowTimestamp);
      return result;
    }

    // Fetch message details to get timestamps
    const messages = await this.config.gmail.batchGetMessages(messageIds);

    // Sort by internalDate (oldest first)
    // Note: Gmail's internalDate is a Unix timestamp in milliseconds, despite the name
    messages.sort((a, b) => {
      const timestampMsA = parseInt(a.internalDate, 10);
      const timestampMsB = parseInt(b.internalDate, 10);
      return timestampMsA - timestampMsB;
    });

    // Filter to only unprocessed messages and take oldest maxMessages
    const unprocessedMessages = [];
    for (const message of messages) {
      if (unprocessedMessages.length >= maxMessages) {
        break;
      }
      const isProcessed = await this.isMessageProcessed(message.id);
      if (!isProcessed) {
        unprocessedMessages.push(message);
      }
    }

    if (unprocessedMessages.length === 0) {
      // All fetched messages already processed, advance timestamp
      const lastMessage = messages[messages.length - 1];
      const newestTimestamp = lastMessage !== undefined
        ? Math.floor(parseInt(lastMessage.internalDate, 10) / 1000)
        : startTimestamp;
      this.logger.info('All messages in batch already processed, advancing', {
        account: this.config.account,
        newTimestamp: newestTimestamp,
      });
      await this.updateSyncStateWithTimestamp(profile.historyId, newestTimestamp + 1);
      result.hasMore = true;
      return result;
    }

    const firstUnprocessed = unprocessedMessages[0];
    this.logger.info('Processing messages', {
      fetched: messages.length,
      unprocessed: unprocessedMessages.length,
      oldestDate: firstUnprocessed !== undefined
        ? new Date(parseInt(firstUnprocessed.internalDate, 10)).toISOString()
        : 'unknown',
      account: this.config.account,
    });

    // Track the newest timestamp we process (Unix seconds)
    let newestProcessedTimestamp = startTimestamp;

    // Process each message
    for (const message of unprocessedMessages) {
      try {
        const processed = await this.processMessage(message);
        result.messagesProcessed++;
        result.contactsCreated += processed.contactsCreated;
        result.companiesCreated += processed.companiesCreated;
        result.domainsCreated += processed.domainsCreated;
        result.emailsCreated += processed.emailsCreated;

        // Mark as processed
        await this.markMessageProcessed(message.id);

        // Track newest timestamp (convert from ms to seconds)
        const messageTimestamp = Math.floor(parseInt(message.internalDate, 10) / 1000);
        if (messageTimestamp > newestProcessedTimestamp) {
          newestProcessedTimestamp = messageTimestamp;
        }
      } catch (error) {
        result.errors.push({
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update sync state with the newest processed timestamp + 1 second
    await this.updateSyncStateWithTimestamp(profile.historyId, newestProcessedTimestamp + 1);
    result.lastTimestamp = newestProcessedTimestamp;

    this.logger.info('Batch sync complete', {
      account: this.config.account,
      lastTimestamp: newestProcessedTimestamp,
      lastDate: new Date(newestProcessedTimestamp * 1000).toISOString(),
      ...result,
    });

    // There's more to process if we haven't reached now
    result.hasMore = newestProcessedTimestamp < nowTimestamp - 3600;

    return result;
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
   * Update sync state with timestamp-based tracking
   * @param historyId - Gmail history ID for incremental sync
   * @param batchLastTimestamp - Unix timestamp of last processed message
   */
  private async updateSyncStateWithTimestamp(historyId: string, batchLastTimestamp: number): Promise<void> {
    const timestamp = now();

    await this.config.db
      .prepare(
        `INSERT INTO sync_state (account, last_history_id, last_sync, batch_last_timestamp, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET
           last_history_id = excluded.last_history_id,
           last_sync = excluded.last_sync,
           batch_last_timestamp = excluded.batch_last_timestamp,
           updated_at = excluded.updated_at`,
      )
      .bind(this.config.account, historyId, timestamp, batchLastTimestamp, timestamp, timestamp)
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
  batchLastTimestamp: number | null;
}[]> {
  const result = await db
    .prepare(
      'SELECT account, last_sync, last_history_id, batch_current_date, batch_last_timestamp FROM sync_state',
    )
    .all<{
      account: string;
      last_sync: string | null;
      last_history_id: string | null;
      batch_current_date: string | null;
      batch_last_timestamp: number | null;
    }>();

  const accounts: AccountType[] = ['work', 'personal'];
  const status = accounts.map((account) => {
    const row = result.results.find((r) => r.account === account);
    return {
      account,
      lastSync: row?.last_sync ?? null,
      lastHistoryId: row?.last_history_id ?? null,
      batchCurrentDate: row?.batch_current_date ?? null,
      batchLastTimestamp: row?.batch_last_timestamp ?? null,
    };
  });

  return status;
}
