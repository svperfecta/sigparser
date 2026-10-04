import { describe, it, expect } from 'vitest';
import {
  canAttemptLogin,
  checkCredentials,
  credentialFingerprint,
  isMcpAuthConfigured,
  recordFailedLogin,
} from '../../src/auth/password.js';
import type { Env } from '../../src/types/index.js';

const env = { AUTH_USERNAME: 'brian', AUTH_PASSWORD: 's3cret' } as Env;

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
}

describe('MCP password sign-in', () => {
  it('is configured only when both credentials are set', () => {
    expect(isMcpAuthConfigured(env)).toBe(true);
    expect(isMcpAuthConfigured({ AUTH_USERNAME: 'brian' } as Env)).toBe(false);
    expect(isMcpAuthConfigured({ AUTH_USERNAME: 'brian', AUTH_PASSWORD: '' } as Env)).toBe(false);
  });

  it('accepts only the exact username and password', async () => {
    expect(await checkCredentials(env, 'brian', 's3cret')).toBe(true);
    expect(await checkCredentials(env, 'brian', 's3cret ')).toBe(false);
    expect(await checkCredentials(env, 'Brian', 's3cret')).toBe(false);
    expect(await checkCredentials(env, '', '')).toBe(false);
    // Never falls back to the web UI's admin/admin development default.
    expect(await checkCredentials({} as Env, 'admin', 'admin')).toBe(false);
  });

  it('changes the fingerprint when the password changes', async () => {
    const before = await credentialFingerprint(env);
    const after = await credentialFingerprint({ ...env, AUTH_PASSWORD: 'other' } as Env);
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    expect(await credentialFingerprint({} as Env)).toBeNull();
  });

  it('blocks an IP after 5 failed attempts', async () => {
    const kv = memoryKv();
    for (let i = 0; i < 5; i++) {
      expect(await canAttemptLogin(kv, '1.2.3.4')).toBe(true);
      await recordFailedLogin(kv, '1.2.3.4');
    }
    expect(await canAttemptLogin(kv, '1.2.3.4')).toBe(false);
    expect(await canAttemptLogin(kv, '5.6.7.8')).toBe(true);
  });
});
