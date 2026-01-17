import { createLogger, type Logger } from '../utils/logger.js';

// === Types ===

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  payload: {
    headers: { name: string; value: string }[];
  };
  internalDate: string;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessage }[];
}

export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// === Constants ===

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_BATCH_SIZE = 100;

// === Gmail Service ===

export class GmailService {
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private logger: Logger;

  constructor(private config: GmailConfig) {
    this.logger = createLogger();
  }

  /**
   * Refresh the access token using the refresh token
   */
  async refreshAccessToken(): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error('Token refresh failed', { status: response.status, error });
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data: TokenResponse = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000 - 60000; // 1 min buffer

    return this.accessToken;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken === null || Date.now() >= this.tokenExpiry) {
      return this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
   * Make an authenticated request to the Gmail API with retry logic
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0,
  ): Promise<T> {
    const token = await this.getAccessToken();

    const response = await fetch(`${GMAIL_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Handle rate limiting and transient errors with exponential backoff
    if (response.status === 429 || response.status === 500 || response.status === 503) {
      if (retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
        this.logger.warn('Rate limited, retrying', {
          status: response.status,
          retryCount,
          delay,
        });
        await this.sleep(delay);
        return this.request<T>(endpoint, options, retryCount + 1);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      this.logger.error('Gmail API error', {
        endpoint,
        status: response.status,
        error,
      });
      throw new Error(`Gmail API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * List messages matching a query
   */
  async listMessages(params: {
    pageToken?: string | undefined;
    maxResults?: number | undefined;
    q?: string | undefined;
  }): Promise<GmailListResponse> {
    const searchParams = new URLSearchParams();

    if (params.maxResults !== undefined) {
      searchParams.set('maxResults', params.maxResults.toString());
    }
    if (params.pageToken !== undefined) {
      searchParams.set('pageToken', params.pageToken);
    }
    if (params.q !== undefined) {
      searchParams.set('q', params.q);
    }

    const query = searchParams.toString();
    const endpoint = `/messages${query !== '' ? `?${query}` : ''}`;

    return this.request<GmailListResponse>(endpoint);
  }

  /**
   * Get a single message by ID
   */
  async getMessage(messageId: string, format = 'metadata'): Promise<GmailMessage> {
    const endpoint = `/messages/${messageId}?format=${format}&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Subject`;
    return this.request<GmailMessage>(endpoint);
  }

  /**
   * Batch get multiple messages
   */
  async batchGetMessages(messageIds: string[]): Promise<GmailMessage[]> {
    const results: GmailMessage[] = [];

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < messageIds.length; i += MAX_BATCH_SIZE) {
      const batch = messageIds.slice(i, i + MAX_BATCH_SIZE);

      // Fetch messages in parallel within batch
      const batchResults = await Promise.all(
        batch.map((id) => this.getMessage(id).catch((error: unknown) => {
          this.logger.warn('Failed to fetch message', {
            messageId: id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        })),
      );

      for (const msg of batchResults) {
        if (msg !== null) {
          results.push(msg);
        }
      }

      // Small delay between batches to respect rate limits
      if (i + MAX_BATCH_SIZE < messageIds.length) {
        await this.sleep(100);
      }
    }

    return results;
  }

  /**
   * Get message history since a given history ID
   */
  async getHistory(params: {
    startHistoryId: string;
    pageToken?: string | undefined;
  }): Promise<GmailHistoryResponse> {
    const searchParams = new URLSearchParams({
      startHistoryId: params.startHistoryId,
      historyTypes: 'messageAdded',
    });

    if (params.pageToken !== undefined) {
      searchParams.set('pageToken', params.pageToken);
    }

    const endpoint = `/history?${searchParams.toString()}`;
    return this.request<GmailHistoryResponse>(endpoint);
  }

  /**
   * Get the current history ID for the mailbox
   */
  async getProfile(): Promise<{ historyId: string; emailAddress: string }> {
    return this.request<{ historyId: string; emailAddress: string }>('/profile');
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Extract a header value from a Gmail message
 */
export function getHeader(message: GmailMessage, name: string): string | null {
  const header = message.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? null;
}
