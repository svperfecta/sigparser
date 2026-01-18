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
  // No-reply variations (hyphen, underscore, dot, or none)
  /^no[._-]?reply/i,
  /^do[._-]?not[._-]?reply/i,
  // System/automated
  /^mailer[._-]?daemon@/i,
  /^postmaster@/i,
  /^bounce[s]?@/i,
  /^auto[._-]?reply/i,
  /^automated/i,
  // Notifications and alerts
  /^notification[s]?@/i,
  /^notify@/i,
  /^alert[s]?@/i,
  // Marketing/bulk
  /^news(letter)?@/i,
  /^marketing@/i,
  /^promo(tion)?s?@/i,
  /^campaign[s]?@/i,
  // Generic department addresses
  /^support@/i,
  /^info@/i,
  /^sales@/i,
  /^hello@/i,
  /^contact@/i,
  /^team@/i,
  /^feedback@/i,
  /^billing@/i,
  /^subscription[s]?@/i,
  /^update[s]?@/i,
  /^service@/i,
  /^help@/i,
  /^admin@/i,
  /^webmaster@/i,
] as const;

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;
