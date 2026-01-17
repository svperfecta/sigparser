export const MAX_THREADS_PER_CONTACT = 100;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const BLACKLIST_CATEGORIES = ['spam', 'personal', 'transactional', 'manual'] as const;

export const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'mail.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'zoho.com',
  'gmx.com',
  'gmx.net',
  'yandex.com',
  'tutanota.com',
  'hey.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'msn.com',
  'hotmail.co.uk',
  'yahoo.co.uk',
  'btinternet.com',
] as const;

export const TRANSACTIONAL_EMAIL_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^mailer-daemon@/i,
  /^notifications?@/i,
  /^notify@/i,
  /^alerts?@/i,
  /^news(letter)?@/i,
  /^support@/i,
  /^info@/i,
  /^sales@/i,
  /^marketing@/i,
  /^hello@/i,
  /^contact@/i,
  /^team@/i,
  /^feedback@/i,
  /^billing@/i,
  /^subscriptions?@/i,
  /^updates?@/i,
] as const;

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;
