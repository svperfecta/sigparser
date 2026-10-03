import { z } from 'zod';
import type { Env } from '../types/index.js';

/**
 * The user's own employment timeline, so MCP results can say where the user was when they
 * knew someone ("you met at Major League Gaming"). Configured as the MY_ROLES secret:
 *
 *   [{"company":"Major League Gaming","emails":["bcorrigan@majorleaguegaming.com"],"from":"2008-05","to":"2016-04"}]
 *
 * `from` / `to` are ISO date prefixes (YYYY, YYYY-MM or YYYY-MM-DD); omit `to` for a current role.
 * Roles may overlap (advisor + operator); every matching role is returned.
 */

const RoleSchema = z.object({
  company: z.string().min(1),
  emails: z.array(z.string()).default([]),
  from: z.string().regex(/^\d{4}(-\d{2}){0,2}$/),
  to: z
    .string()
    .regex(/^\d{4}(-\d{2}){0,2}$/)
    .optional(),
});

export type Role = z.infer<typeof RoleSchema>;

export function parseRoles(env: Env): Role[] {
  if (env.MY_ROLES === undefined || env.MY_ROLES === '') {
    return [];
  }
  try {
    const parsed = z.array(RoleSchema).safeParse(JSON.parse(env.MY_ROLES));
    return parsed.success
      ? parsed.data.map((r) => ({ ...r, emails: r.emails.map((e) => e.trim().toLowerCase()) }))
      : [];
  } catch {
    return [];
  }
}

/** Upper bound for a date prefix: "2016" -> "2016-99", so any 2016 timestamp sorts before it. */
function endOf(prefix: string): string {
  return `${prefix}-99`;
}

/** Companies the user was at on `isoDate` (empty when unknown or no timeline configured). */
export function companiesAt(roles: Role[], isoDate: string | null): string[] {
  if (isoDate === null) {
    return [];
  }
  return roles
    .filter((r) => isoDate >= r.from && (r.to === undefined || isoDate <= endOf(r.to)))
    .map((r) => r.company);
}

/** Company for one of the user's addresses, if any role lists it. */
export function companyForAddress(roles: Role[], address: string): string | null {
  const lower = address.toLowerCase();
  return roles.find((r) => r.emails.includes(lower))?.company ?? null;
}

/** All of the user's own addresses: current mailboxes, MY_OTHER_EMAILS and every role address. */
export function ownEmails(env: Env, roles: Role[] = parseRoles(env)): string[] {
  const all = [
    env.MY_EMAIL_WORK,
    env.MY_EMAIL_PERSONAL,
    ...(env.MY_OTHER_EMAILS ?? '').split(','),
    ...roles.flatMap((r) => r.emails),
  ]
    .map((e) => (e ?? '').trim().toLowerCase())
    .filter((e) => e !== '');
  return [...new Set(all)];
}
