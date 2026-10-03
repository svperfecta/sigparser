import { describe, it, expect } from 'vitest';
import { companiesAt, companyForAddress, ownEmails, parseRoles } from '../../src/services/roles.js';
import type { Env } from '../../src/types/index.js';

const env = {
  MY_EMAIL_WORK: 'me@now.com',
  MY_OTHER_EMAILS: ' Old@Prev.com ,',
  MY_ROLES: JSON.stringify([
    { company: 'MadGlory', emails: ['Brian@MadGlory.com'], from: '2014-03', to: '2017-12' },
    { company: 'Advisor Co', from: '2017-06', to: '2018' },
    { company: 'Now Inc', emails: ['me@now.com'], from: '2022-05' },
  ]),
} as Env;

describe('roles', () => {
  const roles = parseRoles(env);

  it('parses roles and lower-cases addresses', () => {
    expect(roles).toHaveLength(3);
    expect(roles[0]!.emails).toEqual(['brian@madglory.com']);
  });

  it('finds every company covering a date, with inclusive month/year ends', () => {
    expect(companiesAt(roles, '2017-12-31T23:00:00.000Z')).toEqual(['MadGlory', 'Advisor Co']);
    expect(companiesAt(roles, '2018-12-01T00:00:00.000Z')).toEqual(['Advisor Co']);
    expect(companiesAt(roles, '2019-01-01T00:00:00.000Z')).toEqual([]);
    expect(companiesAt(roles, '2026-01-01T00:00:00.000Z')).toEqual(['Now Inc']);
    expect(companiesAt(roles, null)).toEqual([]);
  });

  it('maps an address to its company', () => {
    expect(companyForAddress(roles, 'BRIAN@madglory.com')).toBe('MadGlory');
    expect(companyForAddress(roles, 'x@y.com')).toBeNull();
  });

  it('collects own addresses from all sources without duplicates', () => {
    expect(ownEmails(env, roles).sort()).toEqual(['brian@madglory.com', 'me@now.com', 'old@prev.com']);
  });

  it('ignores a missing or malformed timeline', () => {
    expect(parseRoles({} as Env)).toEqual([]);
    expect(parseRoles({ MY_ROLES: '{not json' } as Env)).toEqual([]);
    expect(parseRoles({ MY_ROLES: '[{"company":"X","from":"bad"}]' } as Env)).toEqual([]);
  });
});
