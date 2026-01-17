import { describe, it, expect } from 'vitest';
import { parseEmailHeader, extractDomain, isValidEmail } from '../../src/utils/email.js';

describe('parseEmailHeader', () => {
  it('parses simple email', () => {
    const result = parseEmailHeader('john@acme.com');
    expect(result).toEqual([{ email: 'john@acme.com', name: null, domain: 'acme.com' }]);
  });

  it('parses email with display name', () => {
    const result = parseEmailHeader('John Smith <john@acme.com>');
    expect(result).toEqual([{ email: 'john@acme.com', name: 'John Smith', domain: 'acme.com' }]);
  });

  it('parses quoted display name', () => {
    const result = parseEmailHeader('"Smith, John" <john@acme.com>');
    expect(result).toEqual([{ email: 'john@acme.com', name: 'Smith, John', domain: 'acme.com' }]);
  });

  it('parses multiple emails', () => {
    const result = parseEmailHeader('john@acme.com, jane@acme.com');
    expect(result).toHaveLength(2);
    expect(result[0]?.email).toBe('john@acme.com');
    expect(result[1]?.email).toBe('jane@acme.com');
  });

  it('handles mixed formats', () => {
    const result = parseEmailHeader('John <john@acme.com>, jane@acme.com');
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('John');
    expect(result[1]?.name).toBeNull();
  });

  it('normalizes email to lowercase', () => {
    const result = parseEmailHeader('JOHN@ACME.COM');
    expect(result[0]?.email).toBe('john@acme.com');
  });

  it('returns empty array for invalid input', () => {
    expect(parseEmailHeader('')).toEqual([]);
    expect(parseEmailHeader('not-an-email')).toEqual([]);
  });
});

describe('extractDomain', () => {
  it('extracts domain from email', () => {
    expect(extractDomain('john@acme.com')).toBe('acme.com');
  });

  it('handles subdomains', () => {
    expect(extractDomain('john@mail.acme.com')).toBe('mail.acme.com');
  });

  it('returns null for invalid email', () => {
    expect(extractDomain('invalid')).toBeNull();
    expect(extractDomain('invalid@')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('validates correct emails', () => {
    expect(isValidEmail('john@acme.com')).toBe(true);
    expect(isValidEmail('john.doe@acme.co.uk')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(isValidEmail('invalid')).toBe(false);
    expect(isValidEmail('@acme.com')).toBe(false);
    expect(isValidEmail('john@')).toBe(false);
    expect(isValidEmail('john@acme')).toBe(false);
  });
});
