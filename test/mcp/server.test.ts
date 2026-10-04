import { describe, it, expect, beforeEach } from 'vitest';
import { handleMcpRequest } from '../../src/mcp/handler.js';
import type { Env } from '../../src/types/index.js';
import { createTestD1 } from '../helpers/d1.js';
import { credentialFingerprint } from '../../src/auth/password.js';

const NOW = Date.now();
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();

let env: Env;

function seed(sqlite: ReturnType<typeof createTestD1>['sqlite']): void {
  const t = iso(0);
  sqlite.exec(
    `INSERT INTO companies (id, name, created_at, updated_at) VALUES ('co1', 'Acme', '${t}', '${t}')`,
  );
  sqlite.exec(`INSERT INTO domains (domain, company_id, created_at, updated_at) VALUES
    ('acme.com', 'co1', '${t}', '${t}'), ('eu.acme.com', 'co1', '${t}', '${t}'), ('other.com', 'co1', '${t}', '${t}')`);
  const contact = (
    id: string,
    name: string,
    to: number,
    from: number,
    lastSeen: string,
    email: string,
    domain: string,
  ): void => {
    sqlite.exec(`INSERT INTO contacts (id, company_id, name, emails_to, emails_from, last_seen, created_at, updated_at)
      VALUES ('${id}', 'co1', '${name}', ${to}, ${from}, '${lastSeen}', '${t}', '${t}')`);
    sqlite.exec(`INSERT INTO emails (email, contact_id, domain, created_at, updated_at)
      VALUES ('${email}', '${id}', '${domain}', '${t}', '${t}')`);
  };
  contact('c1', 'Old Friend', 20, 15, iso(800), 'old@acme.com', 'acme.com');
  contact('c2', 'Recent Pal', 30, 30, iso(10), 'recent@eu.acme.com', 'eu.acme.com');
  contact('c3', 'Newsletter', 0, 500, iso(900), 'news@acme.com', 'acme.com');
  contact('c4', 'Elsewhere', 5, 5, iso(800), 'x@other.com', 'other.com');
  contact('c5', 'Me Old', 50, 50, iso(800), 'me@old.com', 'other.com');
}

async function post(
  name: string,
  args: Record<string, unknown>,
  props: unknown,
): Promise<Response> {
  const request = new Request('https://sigparser.example.com/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    }),
  });
  return handleMcpRequest(request, env, { props } as unknown as ExecutionContext);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const fingerprint = await credentialFingerprint(env);
  const response = await post(name, args, { username: 'owner', fingerprint });
  const raw = await response.text();
  const json = raw.startsWith('{')
    ? raw
    : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice(6);
  const body = JSON.parse(json) as { result?: { content: { text: string }[] }; error?: unknown };
  if (body.result === undefined) {
    throw new Error(`MCP error: ${JSON.stringify(body)}`);
  }
  return JSON.parse(body.result.content[0]!.text);
}

describe('MCP server', () => {
  beforeEach(() => {
    const { d1, sqlite } = createTestD1();
    seed(sqlite);
    env = {
      DB: d1,
      MY_EMAIL_WORK: 'me@work.com',
      MY_OTHER_EMAILS: 'ME@old.com',
      AUTH_USERNAME: 'owner',
      AUTH_PASSWORD: 'correct horse',
    } as Env;
  });

  it('search_contacts filters by domain including subdomains', async () => {
    const result = (await callTool('search_contacts', { domain: '@acme.com' })) as {
      contacts: { id: string }[];
    };
    expect(result.contacts.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('search_contacts two_way_only drops one-way senders', async () => {
    const result = (await callTool('search_contacts', {
      domain: 'acme.com',
      two_way_only: true,
    })) as {
      contacts: { id: string; emails: string }[];
    };
    expect(result.contacts.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(result.contacts[1]!.emails).toBe('old@acme.com');
  });

  it('find_dormant_contacts returns quiet two-way relationships, most reciprocal first, without the user', async () => {
    const result = (await callTool('find_dormant_contacts', {})) as { contacts: { id: string }[] };
    expect(result.contacts.map((c) => c.id)).toEqual(['c1', 'c4']);

    const scoped = (await callTool('find_dormant_contacts', { domain: 'acme.com' })) as {
      contacts: { id: string }[];
    };
    expect(scoped.contacts.map((c) => c.id)).toEqual(['c1']);

    const recentOnly = (await callTool('find_dormant_contacts', {
      quiet_for_days: 365,
      active_within_days: 700,
    })) as {
      contacts: unknown[];
    };
    expect(recentOnly.contacts).toEqual([]);
  });

  it('refuses grants without the current credential fingerprint', async () => {
    const good = await credentialFingerprint(env);
    expect((await post('sync_status', {}, { username: 'owner', fingerprint: good })).status).toBe(
      200,
    );
    expect(
      (await post('sync_status', {}, { username: 'owner', fingerprint: 'stale' })).status,
    ).toBe(403);
    expect((await post('sync_status', {}, undefined)).status).toBe(403);

    // Changing the password signs out grants approved with the old one.
    env = { ...env, AUTH_PASSWORD: 'new password' } as Env;
    expect((await post('sync_status', {}, { username: 'owner', fingerprint: good })).status).toBe(
      403,
    );

    // No credentials configured: nothing gets in.
    env = { ...env, AUTH_PASSWORD: '' } as Env;
    expect((await post('sync_status', {}, { username: 'owner', fingerprint: good })).status).toBe(
      403,
    );
  });

  it('get_conversation_context refuses a search-operator email', async () => {
    const result = (await callTool('get_conversation_context', {
      email: 'x} OR in:anywhere {',
    })) as {
      threads: unknown[];
      errors: { error: string }[];
    };
    expect(result.threads).toEqual([]);
    expect(result.errors[0]!.error).toMatch(/No valid email/);
  });

  it('get_conversation_context reads no mailbox when none is configured', async () => {
    const result = (await callTool('get_conversation_context', { email: 'old@acme.com' })) as {
      searchedAccounts: string[];
      threads: unknown[];
      contact: { addresses: string[] };
    };
    expect(result.searchedAccounts).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.contact.addresses).toEqual(['old@acme.com']);
  });
});
