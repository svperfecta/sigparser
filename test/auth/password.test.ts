import { describe, it, expect } from 'vitest';
import {
  admitLoginAttempt,
  clearLoginAttempts,
  clientKey,
  checkCredentials,
  credentialFingerprint,
  isMcpAuthConfigured,
} from '../../src/auth/password.js';
import type { Env } from '../../src/types/index.js';
import { createTestD1 } from '../helpers/d1.js';

const env = { AUTH_USERNAME: 'brian', AUTH_PASSWORD: 's3cret' } as Env;

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

  it('allows 5 attempts per client per window, then blocks; other clients unaffected', async () => {
    const { d1 } = createTestD1();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(await admitLoginAttempt(d1, '1.2.3.4', t + i)).toBe(true);
    }
    expect(await admitLoginAttempt(d1, '1.2.3.4', t + 10)).toBe(false);
    expect(await admitLoginAttempt(d1, '5.6.7.8', t + 11)).toBe(true);
    // A new window starts after 15 minutes.
    expect(await admitLoginAttempt(d1, '1.2.3.4', t + 15 * 60 * 1000 + 20)).toBe(true);
  });

  it('caps attempts globally, so rotating IPs does not help', async () => {
    const { d1 } = createTestD1();
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) {
      results.push(await admitLoginAttempt(d1, `10.0.0.${i}`, 5_000 + i));
    }
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(results.slice(20).every((r) => !r)).toBe(true);
  });

  it('groups IPv6 clients by /64', async () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb::9'));
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    const { d1 } = createTestD1();
    for (let i = 0; i < 5; i++) {
      await admitLoginAttempt(d1, `2001:db8:1:2:${i}::1`, 9_000 + i);
    }
    expect(await admitLoginAttempt(d1, '2001:db8:1:2:ffff::1', 9_100)).toBe(false);
  });

  it("a successful sign-in clears that client's counter", async () => {
    const { d1 } = createTestD1();
    for (let i = 0; i < 5; i++) {
      await admitLoginAttempt(d1, '1.2.3.4', 1 + i);
    }
    await clearLoginAttempts(d1, '1.2.3.4');
    expect(await admitLoginAttempt(d1, '1.2.3.4', 10)).toBe(true);
  });
});
