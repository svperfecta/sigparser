import { describe, it, expect } from 'vitest';
import { PERSONAL_EMAIL_DOMAINS, TRANSACTIONAL_EMAIL_PATTERNS } from '../../src/types/constants.js';

describe('Blacklist Constants', () => {
  describe('PERSONAL_EMAIL_DOMAINS', () => {
    it('contains common personal email domains', () => {
      expect(PERSONAL_EMAIL_DOMAINS).toContain('gmail.com');
      expect(PERSONAL_EMAIL_DOMAINS).toContain('yahoo.com');
      expect(PERSONAL_EMAIL_DOMAINS).toContain('hotmail.com');
      expect(PERSONAL_EMAIL_DOMAINS).toContain('outlook.com');
      expect(PERSONAL_EMAIL_DOMAINS).toContain('icloud.com');
    });

    it('has lowercase domains', () => {
      for (const domain of PERSONAL_EMAIL_DOMAINS) {
        expect(domain).toBe(domain.toLowerCase());
      }
    });
  });

  describe('TRANSACTIONAL_EMAIL_PATTERNS', () => {
    it('matches noreply emails', () => {
      const noReplyPattern = TRANSACTIONAL_EMAIL_PATTERNS.find((p) => p.test('noreply@example.com'));
      expect(noReplyPattern).toBeDefined();
    });

    it('matches no-reply emails', () => {
      const noReplyPattern = TRANSACTIONAL_EMAIL_PATTERNS.find((p) => p.test('no-reply@example.com'));
      expect(noReplyPattern).toBeDefined();
    });

    it('matches notifications emails', () => {
      const pattern = TRANSACTIONAL_EMAIL_PATTERNS.find((p) => p.test('notifications@example.com'));
      expect(pattern).toBeDefined();
    });

    it('is case insensitive', () => {
      const pattern = TRANSACTIONAL_EMAIL_PATTERNS.find((p) => p.test('NOREPLY@example.com'));
      expect(pattern).toBeDefined();
    });

    it('does not match regular emails', () => {
      const regularEmail = 'john@example.com';
      const matchingPattern = TRANSACTIONAL_EMAIL_PATTERNS.find((p) => p.test(regularEmail));
      expect(matchingPattern).toBeUndefined();
    });
  });
});

describe('Transactional Pattern Matching', () => {
  const testCases = [
    { email: 'noreply@company.com', expected: true },
    { email: 'no-reply@company.com', expected: true },
    { email: 'no_reply@company.com', expected: true },
    { email: 'no.reply@company.com', expected: true },
    { email: 'donotreply@company.com', expected: true },
    { email: 'do-not-reply@company.com', expected: true },
    { email: 'do_not_reply@company.com', expected: true },
    { email: 'do.not.reply@company.com', expected: true },
    { email: 'notifications@company.com', expected: true },
    { email: 'notification@company.com', expected: true },
    { email: 'alerts@company.com', expected: true },
    { email: 'alert@company.com', expected: true },
    { email: 'newsletter@company.com', expected: true },
    { email: 'news@company.com', expected: true },
    { email: 'support@company.com', expected: true },
    { email: 'info@company.com', expected: true },
    { email: 'sales@company.com', expected: true },
    { email: 'marketing@company.com', expected: true },
    { email: 'billing@company.com', expected: true },
    { email: 'updates@company.com', expected: true },
    { email: 'john.smith@company.com', expected: false },
    { email: 'ceo@company.com', expected: false },
    { email: 'engineering@company.com', expected: false },
  ];

  for (const { email, expected } of testCases) {
    it(`${expected ? 'matches' : 'does not match'} "${email}"`, () => {
      const isTransactional = TRANSACTIONAL_EMAIL_PATTERNS.some((p) => p.test(email));
      expect(isTransactional).toBe(expected);
    });
  }
});
