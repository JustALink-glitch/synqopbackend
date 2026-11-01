import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { rateLimit, type Rule } from '../src/lib/rate-limit.js'

const rule = (over: Partial<Rule>): Rule => ({ name: 'test', limit: 2, windowMs: 60_000, match: () => true, ...over })

function app(rules: Rule[], options: { trustProxy?: number; now?: () => number } = {}) {
  const a = new Hono()
  a.use(rateLimit({ rules, ceiling: rule({ name: 'ip', limit: 100, perIp: true }), ...options }))
  a.all('*', (c) => c.json({ ok: true }))
  return a
}
const call = (a: Hono, path = '/x', headers: Record<string, string> = {}, method = 'GET') => a.request(path, { method, headers })

describe('rate limits', () => {
  it('lets requests through up to the limit, then answers 429 with Retry-After', async () => {
    const a = app([rule({ limit: 2 })])
    expect((await call(a)).status).toBe(200)
    expect((await call(a)).status).toBe(200)
    const res = await call(a)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited', details: { rule: 'test' } } })
  })

  it('starts counting again when the window ends', async () => {
    let t = 0
    const a = app([rule({ limit: 1, windowMs: 1000 })], { now: () => t })
    expect((await call(a)).status).toBe(200)
    expect((await call(a)).status).toBe(429)
    t = 1000
    expect((await call(a)).status).toBe(200)
  })

  it('counts signed-in people separately, even from one IP (a training centre)', async () => {
    const a = app([rule({ limit: 1 })])
    expect((await call(a, '/x', { authorization: 'Bearer a' })).status).toBe(200)
    expect((await call(a, '/x', { authorization: 'Bearer b' })).status).toBe(200)
    expect((await call(a, '/x', { authorization: 'Bearer a' })).status).toBe(429)
  })

  it('counts public endpoints per IP, whatever token is sent', async () => {
    const a = app([rule({ limit: 1, perIp: true })], { trustProxy: 1 })
    expect((await call(a, '/x', { authorization: 'Bearer a', 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await call(a, '/x', { authorization: 'Bearer b', 'x-forwarded-for': '1.1.1.1' })).status).toBe(429)
    expect((await call(a, '/x', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200)
  })

  it('takes the IP the proxy added, so a forged X-Forwarded-For does not dodge the limit', async () => {
    const a = app([rule({ limit: 1, perIp: true })], { trustProxy: 1 })
    expect((await call(a, '/x', { 'x-forwarded-for': 'forged-1, 9.9.9.9' })).status).toBe(200)
    expect((await call(a, '/x', { 'x-forwarded-for': 'forged-2, 9.9.9.9' })).status).toBe(429)
  })

  it('can count per path (one invitation link) instead of per IP', async () => {
    const a = app([rule({ limit: 1, perIp: true, perPath: true })])
    expect((await call(a, '/inv/a')).status).toBe(200)
    expect((await call(a, '/inv/b')).status).toBe(200)
    expect((await call(a, '/inv/a')).status).toBe(429)
  })

  it('applies the per-IP ceiling to every request', async () => {
    const a = new Hono()
    a.use(rateLimit({ rules: [], ceiling: rule({ name: 'ip', limit: 2, perIp: true }) }))
    a.all('*', (c) => c.json({ ok: true }))
    await call(a, '/x', { authorization: 'Bearer a' })
    await call(a, '/x', { authorization: 'Bearer b' })
    expect((await call(a, '/x', { authorization: 'Bearer c' })).status).toBe(429)
  })

  it('never limits the health check or CORS preflights', async () => {
    const a = app([rule({ limit: 0 })])
    expect((await call(a, '/health')).status).toBe(200)
    expect((await call(a, '/x', {}, 'OPTIONS')).status).not.toBe(429)
  })

  it('limits password-reset requests in the real app, and the browser can read the 429', async () => {
    const real = createApp({
      corsOrigins: ['http://localhost:5173'],
      appUrl: 'http://localhost:5173',
      sql: (() => {
        throw new Error('no database in this test')
      }) as never,
      verifyToken: async () => null,
      loadMembership: (async () => null) as never,
      authAdmin: {} as never,
      mailer: { send: async () => {} },
      storage: {} as never,
      log: false,
      rateLimit: { rules: [rule({ name: 'password-reset', limit: 0, perIp: true, match: (_m, p) => p.startsWith('/v1/auth/password-reset') })] },
    })
    const res = await real.request('/v1/auth/password-reset', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co' }),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })
})
