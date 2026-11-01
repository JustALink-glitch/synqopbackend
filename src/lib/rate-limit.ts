import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

/**
 * Request limits (security hardening, Nov 2026).
 *
 * Fixed one-window counters kept in memory. That is right for a single API instance (the scheduler already
 * assumes one); with several instances, move the counters to Postgres or Redis.
 *
 * Who is counted:
 * - Signed-in requests count per sign-in token, so a whole training centre behind one office IP is not
 *   limited as one person.
 * - Requests without a token count per IP address.
 * - Every request also counts towards a generous per-IP ceiling, which stops floods of made-up tokens.
 */
export interface Rule {
  /** Shown in the 429 response's details and in logs. */
  name: string
  limit: number
  windowMs: number
  /** Which requests the rule covers. */
  match: (method: string, path: string) => boolean
  /** Count per IP even when a token is sent (for public endpoints). */
  perIp?: boolean
  /** Count per IP and path (e.g. per invitation link), not per IP alone. */
  perPath?: boolean
}

const minute = 60_000
const post = (method: string) => method === 'POST'

/** The order matters: the first matching rule (besides the IP ceiling) is the one that applies. */
export const defaultRules: Rule[] = [
  // Public endpoints: someone guessing reset requests or invitation links.
  { name: 'password-reset', limit: 10, windowMs: 15 * minute, perIp: true, match: (m, p) => post(m) && p.startsWith('/v1/auth/password-reset') },
  // Per link, so a class accepting invitations together from one office IP isn't blocked…
  { name: 'invitation-link', limit: 20, windowMs: 15 * minute, perIp: true, perPath: true, match: (_m, p) => p.startsWith('/v1/invitations/') },
  // …but one IP can't try thousands of links.
  { name: 'invitations', limit: 200, windowMs: 15 * minute, perIp: true, match: (_m, p) => p.startsWith('/v1/invitations') },
  // Creating organisations (R1.02).
  { name: 'organisation-signup', limit: 5, windowMs: 60 * minute, match: (m, p) => post(m) && p === '/v1/organisations' },
  // Expensive work: reports, exports, data export, bulk import.
  {
    name: 'heavy',
    limit: 30,
    windowMs: 10 * minute,
    match: (m, p) => post(m) && (p.startsWith('/v1/reports') || p.startsWith('/v1/privacy') || p.startsWith('/v1/participants/import')),
  },
  // Everything else a signed-in person does.
  { name: 'default', limit: 600, windowMs: minute, match: () => true },
]

export const ipCeiling: Rule = { name: 'ip', limit: 3000, windowMs: minute, perIp: true, match: () => true }

export interface RateLimitOptions {
  rules?: Rule[]
  ceiling?: Rule
  /** How many proxies sit in front of the API (Render: 1). 0 = use the socket address. */
  trustProxy?: number
  now?: () => number
}

/** The caller's IP. Behind N trusted proxies, the Nth address from the right of X-Forwarded-For. */
export function clientIp(c: Context, trustProxy: number): string {
  if (trustProxy > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ip = chain[chain.length - trustProxy]
    if (ip) return ip
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown' // in-process requests (tests)
  }
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const rules = options.rules ?? defaultRules
  const ceiling = options.ceiling ?? ipCeiling
  const trustProxy = options.trustProxy ?? 0
  const now = options.now ?? Date.now
  const counters = new Map<string, { count: number; resetAt: number }>()
  let nextSweep = 0

  /** Counts one request; returns seconds to wait if over the limit. */
  const hit = (key: string, rule: Rule, at: number): number | null => {
    let entry = counters.get(key)
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + rule.windowMs }
      counters.set(key, entry)
    }
    entry.count += 1
    return entry.count > rule.limit ? Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) : null
  }

  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/health') return next()
    const at = now()
    if (at >= nextSweep) {
      for (const [key, entry] of counters) if (entry.resetAt <= at) counters.delete(key)
      nextSweep = at + minute
    }

    const ip = clientIp(c, trustProxy)
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const who = token ? `t:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}` : `ip:${ip}`
    const rule = rules.find((r) => r.match(c.req.method, c.req.path))

    const checks: [string, Rule][] = [[`${ceiling.name}|ip:${ip}`, ceiling]]
    if (rule) checks.push([`${rule.name}|${rule.perIp ? `ip:${ip}` : who}${rule.perPath ? `|${c.req.path}` : ''}`, rule])

    for (const [key, r] of checks) {
      const wait = hit(key, r, at)
      if (wait !== null) {
        c.header('Retry-After', String(wait))
        return c.json(
          { error: { code: 'rate_limited', message: 'Too many requests. Wait a moment and try again.', details: { rule: r.name, retryAfterSeconds: wait } } },
          429,
        )
      }
    }
    return next()
  }
}
