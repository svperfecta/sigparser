export interface ParsedEmail {
  email: string;
  name: string | null;
  domain: string;
}

/**
 * Parse an email header value into structured email addresses
 * Handles formats like:
 * - "john@acme.com"
 * - "John Smith <john@acme.com>"
 * - "john@acme.com, jane@acme.com"
 */
export function parseEmailHeader(header: string): ParsedEmail[] {
  const results: ParsedEmail[] = [];

  // Split by comma, but be careful of commas inside quotes
  const parts = splitEmailList(header);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }

    const parsed = parseSingleEmail(trimmed);
    if (parsed !== null) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Split an email list by commas, respecting quoted strings
 */
function splitEmailList(header: string): string[] {
  const results: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngleBrackets = false;

  for (const char of header) {
    if (char === '"' && !inAngleBrackets) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '<' && !inQuotes) {
      inAngleBrackets = true;
      current += char;
    } else if (char === '>' && !inQuotes) {
      inAngleBrackets = false;
      current += char;
    } else if (char === ',' && !inQuotes && !inAngleBrackets) {
      results.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current !== '') {
    results.push(current);
  }

  return results;
}

/**
 * Parse a single email address
 */
function parseSingleEmail(input: string): ParsedEmail | null {
  // Try format: "Name <email@domain.com>"
  const angleMatch = /<([^>]+)>/.exec(input);
  if (angleMatch !== null) {
    const email = angleMatch[1]?.toLowerCase().trim();
    if (email === undefined || !isValidEmail(email)) {
      return null;
    }

    // Extract name (everything before the angle bracket)
    let name = input.substring(0, input.indexOf('<')).trim();
    // Remove quotes if present
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1);
    }

    const domain = extractDomain(email);
    if (domain === null) {
      return null;
    }

    return {
      email,
      name: name !== '' ? name : null,
      domain,
    };
  }

  // Try format: "email@domain.com"
  const email = input.toLowerCase().trim();
  if (!isValidEmail(email)) {
    return null;
  }

  const domain = extractDomain(email);
  if (domain === null) {
    return null;
  }

  return {
    email,
    name: null,
    domain,
  };
}

/**
 * Extract domain from an email address
 */
export function extractDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1 || atIndex === email.length - 1) {
    return null;
  }
  return email.substring(atIndex + 1).toLowerCase();
}

/**
 * Basic email validation
 */
export function isValidEmail(email: string): boolean {
  // Basic check: contains @ and has characters on both sides
  const atIndex = email.indexOf('@');
  if (atIndex < 1 || atIndex === email.length - 1) {
    return false;
  }

  // Check domain has at least one dot
  const domain = email.substring(atIndex + 1);
  if (!domain.includes('.')) {
    return false;
  }

  return true;
}

/**
 * Normalize an email address (lowercase, trim)
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
