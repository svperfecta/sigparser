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
  /^root@/i,
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
  // Educational institutions
  /\.edu$/i,
  /\.edu\s/i,
  // 3+ level subdomains (x.y.z or x.y.z.w) - almost always internal/junk
  // Matches: foo@sub.domain.com, foo@a.b.c.com (but whitelist can override)
  /@[^@]+\.[^.]+\.[^.]+$/i,
  // Marketing subdomain patterns (email.company.com, e.company.com, etc.)
  /@email\.[^.]+\.[^.]+$/i,
  /@e\.[^.]+\.[^.]+$/i,
  /@t\.[^.]+\.[^.]+$/i,
  /@m\.[^.]+\.[^.]+$/i,
  /@action\.[^.]+\.[^.]+$/i,
  /@notify\.[^.]+\.[^.]+$/i,
  /@notifications?\.[^.]+\.[^.]+$/i,
  /@alerts?\.[^.]+\.[^.]+$/i,
  /@mail\.[^.]+\.[^.]+$/i,
  /@news\.[^.]+\.[^.]+$/i,
  /@promo\.[^.]+\.[^.]+$/i,
  /@offers?\.[^.]+\.[^.]+$/i,
  /@campaign\.[^.]+\.[^.]+$/i,
  /@info\.[^.]+\.[^.]+$/i,
  /@messages?\.[^.]+\.[^.]+$/i,
] as const;

// Domains to whitelist (override transactional patterns)
export const WHITELISTED_DOMAINS = [
  'playstation.sony.com',
] as const;

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;
