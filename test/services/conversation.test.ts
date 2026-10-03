import { describe, it, expect, vi } from 'vitest';
import { addressQuery, messageText, readableAccounts } from '../../src/services/conversation.js';
import type { GmailFullMessage } from '../../src/services/gmail.js';
import type { Env } from '../../src/types/index.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64url');

function message(parts: GmailFullMessage['payload']): GmailFullMessage {
  return { id: 'm', threadId: 't', internalDate: '0', snippet: 'snippet', payload: parts };
}

describe('messageText', () => {
  it('returns the new text and drops quoted history', () => {
    const body =
      'Sounds great, let us talk Tuesday.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> earlier text';
    const msg = message({ mimeType: 'text/plain', body: { data: b64(body), size: body.length } });
    expect(messageText(msg)).toBe('Sounds great, let us talk Tuesday.');
  });

  it('prefers text/plain inside multipart, falls back to html, then snippet', () => {
    const multipart = message({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>html</p>'), size: 11 } },
        { mimeType: 'text/plain', body: { data: b64('plain'), size: 5 } },
      ],
    });
    expect(messageText(multipart)).toBe('plain');

    const htmlOnly = message({
      mimeType: 'text/html',
      body: { data: b64('<p>Hi&nbsp;there</p><br>Bob'), size: 1 },
    });
    expect(messageText(htmlOnly)).toBe('Hi there\n\nBob');

    expect(messageText(message({ mimeType: 'multipart/mixed', parts: [] }))).toBe('snippet');
  });
});

describe('addressQuery', () => {
  it('matches from, to and cc for every address', () => {
    expect(addressQuery(['a@x.com', ' B@Y.com '])).toBe(
      '{from:a@x.com to:a@x.com cc:a@x.com from:b@y.com to:b@y.com cc:b@y.com}',
    );
  });

  it('refuses anything that could carry Gmail search operators', () => {
    expect(addressQuery(['x} OR in:anywhere {'])).toBeNull();
    expect(addressQuery(['a@x.com} in:sent {'])).toBeNull();
    expect(addressQuery(['a@x.com OR b@y.com'])).toBeNull();
    expect(addressQuery(['(a@x.com)'])).toBeNull();
    expect(addressQuery(['bad', 'ok@x.com'])).toBe('{from:ok@x.com to:ok@x.com cc:ok@x.com}');
  });
});

describe('readableAccounts', () => {
  const base = { GMAIL_REFRESH_TOKEN_WORK: 'w', GMAIL_REFRESH_TOKEN_PERSONAL: 'p' } as Env;

  it('defaults to work only', () => {
    expect(readableAccounts(base)).toEqual(['work']);
  });

  it('honours MCP_GMAIL_ACCOUNTS and drops accounts without a token', () => {
    expect(readableAccounts({ ...base, MCP_GMAIL_ACCOUNTS: 'work, personal' })).toEqual([
      'work',
      'personal',
    ]);
    expect(
      readableAccounts({
        ...base,
        GMAIL_REFRESH_TOKEN_PERSONAL: '',
        MCP_GMAIL_ACCOUNTS: 'personal',
      } as Env),
    ).toEqual([]);
  });
});

describe('getConversationContext', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64url');
  const msg = (
    from: string,
    to: string,
    date: string,
    text: string,
    extra: { name: string; value: string }[] = [],
  ) => ({
    id: date,
    threadId: 't1',
    internalDate: String(Date.parse(date)),
    snippet: text,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Q3 launch' },
        ...extra,
      ],
      body: { data: b64(text), size: text.length },
    },
  });

  it('reports your company then, the last writer and a lastTalked summary', async () => {
    const thread = {
      id: 't1',
      messages: [
        msg(
          'Brian <brian@madglory.com>',
          'Pat <pat@acme.com>',
          '2017-03-01T10:00:00Z',
          'Kickoff notes',
          [{ name: 'Delivered-To', value: 'brian@madglory.com' }],
        ),
        msg(
          'Pat <pat@acme.com>',
          'brian@madglory.com',
          '2017-03-02T10:00:00Z',
          'Sounds good, ship it',
        ),
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) {
        return Response.json({ access_token: 'x', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.includes('/messages?')) {
        return Response.json({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 });
      }
      return Response.json(thread);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getConversationContext } = await import('../../src/services/conversation.js');
    const env = {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN_WORK: 'w',
      MY_ROLES: JSON.stringify([
        { company: 'MadGlory', emails: ['brian@madglory.com'], from: '2014', to: '2017' },
      ]),
    } as Env;

    const context = await getConversationContext(env, ['pat@acme.com'], {
      threads: 1,
      messagesPerThread: 5,
    });
    vi.unstubAllGlobals();

    expect(context.lastTalked).toEqual({
      date: '2017-03-02T10:00:00.000Z',
      subject: 'Q3 launch',
      yourCompanyThen: 'MadGlory',
      lastWriter: 'them',
    });
    expect(context.threads[0]!.you).toEqual({
      addresses: ['brian@madglory.com'],
      company: 'MadGlory',
    });
    expect(context.threads[0]!.messages.map((m) => m.text)).toEqual([
      'Kickoff notes',
      'Sounds good, ship it',
    ]);
    // Only the work mailbox is read by default.
    expect(context.searchedAccounts).toEqual(['work']);
  });
});
