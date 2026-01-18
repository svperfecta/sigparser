import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { getSyncStatus, SyncService, type AccountType } from '../../services/sync.js';
import { GmailService } from '../../services/gmail.js';
import { AppError } from '../../middleware/error.js';
import { createLogger } from '../../utils/logger.js';

const sync = new Hono<{ Bindings: Env }>();

/**
 * GET /api/sync/status - Get sync status for all accounts
 */
sync.get('/status', async (c) => {
  const status = await getSyncStatus(c.env.DB);
  return c.json({ data: status });
});

/**
 * POST /api/sync/trigger - Manually trigger sync
 */
sync.post('/trigger', async (c) => {
  const logger = createLogger();

  interface TriggerBody {
    account?: string;
    full?: boolean;
  }

  const body: TriggerBody = await c.req.json<TriggerBody>().catch(() => ({}));

  const accountInput = body.account ?? 'work';
  const full = body.full ?? false;

  // Validate account
  if (accountInput !== 'work' && accountInput !== 'personal') {
    throw new AppError('Invalid account type', 'VALIDATION_ERROR', 400);
  }
  const account: AccountType = accountInput;

  // Get the appropriate config based on account
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = account === 'work' ? c.env.GMAIL_REFRESH_TOKEN_WORK : c.env.GMAIL_REFRESH_TOKEN_PERSONAL;
  const myEmail = account === 'work' ? c.env.MY_EMAIL_WORK : c.env.MY_EMAIL_PERSONAL;

  if (refreshToken === undefined || myEmail === undefined) {
    throw new AppError(`${account} account is not configured`, 'VALIDATION_ERROR', 400);
  }

  const gmail = new GmailService({
    clientId,
    clientSecret,
    refreshToken,
  });

  const syncService = new SyncService({
    gmail,
    db: c.env.DB,
    myEmail,
    account,
  });

  logger.info('Manual sync triggered', { account, full });

  // Check if account has caught up (batch sync complete)
  const status = await getSyncStatus(c.env.DB);
  const accountStatus = status.find((s) => s.account === account);
  const nowTimestamp = Math.floor(Date.now() / 1000);

  // hasCaughtUp = true when last processed timestamp is within 1 hour of now
  const hasCaughtUp =
    accountStatus !== undefined &&
    accountStatus.batchLastTimestamp !== null &&
    accountStatus.batchLastTimestamp >= nowTimestamp - 3600;

  // Run appropriate sync type:
  // - full: process all messages (slow, use sparingly)
  // - incremental: use Gmail history API (fast, for already-synced accounts)
  // - batch: process one day at a time oldest-first (for catch-up)
  let result;
  let syncType: string;

  if (full) {
    result = await syncService.fullSync();
    syncType = 'full';
  } else if (hasCaughtUp) {
    result = await syncService.incrementalSync();
    syncType = 'incremental';
  } else {
    result = await syncService.batchSync();
    syncType = 'batch';
  }

  return c.json({
    success: true,
    account,
    type: syncType,
    result,
  });
});

/**
 * GET /api/sync/test-query - Test Gmail query with timestamp
 * Query params: ?after=UNIX_TIMESTAMP&before=UNIX_TIMESTAMP&limit=5
 */
sync.get('/test-query', async (c) => {
  const afterTimestamp = c.req.query('after');
  const beforeTimestamp = c.req.query('before');
  const limit = parseInt(c.req.query('limit') ?? '5', 10);

  const gmail = new GmailService({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    refreshToken: c.env.GMAIL_REFRESH_TOKEN_PERSONAL ?? '',
  });

  // Build query using Gmail's after: and before: operators (accept Unix timestamps)
  let query = '';
  if (afterTimestamp !== undefined) {
    query += `after:${afterTimestamp} `;
  }
  if (beforeTimestamp !== undefined) {
    query += `before:${beforeTimestamp}`;
  }

  const result = await gmail.listMessages({
    maxResults: limit,
    q: query.trim() || undefined,
  });

  // Get details of first few messages to see their timestamps
  const messageDetails = [];
  if (result.messages !== undefined) {
    for (const msg of result.messages.slice(0, 3)) {
      const details = await gmail.getMessage(msg.id);
      // Note: Gmail's internalDate is Unix timestamp in milliseconds
      const internalDateMs = parseInt(details.internalDate, 10);
      messageDetails.push({
        id: msg.id,
        internalDateMs,
        dateISO: new Date(internalDateMs).toISOString(),
      });
    }
  }

  return c.json({
    query: query.trim(),
    resultCount: result.messages?.length ?? 0,
    hasMore: result.nextPageToken !== undefined,
    messages: messageDetails,
  });
});

export default sync;
