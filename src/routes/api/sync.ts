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

  // Run sync (this could take a while, but Cloudflare Workers allow up to 30s for HTTP requests)
  const result = full ? await syncService.fullSync() : await syncService.incrementalSync();

  return c.json({
    success: true,
    account,
    type: full ? 'full' : 'incremental',
    result,
  });
});

export default sync;
