import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTurnstileCheck } from '../src/lib/human-check.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { client, testApp } from './helpers/app.js'

describe('Turnstile check', () => {
  const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response)

  it('passes only when Cloudflare says success', async () => {
    const yes = reply({ success: true })
    expect(await createTurnstileCheck('secret', yes)('token')).toBe(true)
    expect(JSON.parse((yes.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ secret: 'secret', response: 'token' })
    expect(await createTurnstileCheck('secret', reply({ success: false }))('token')).toBe(false)
    expect(await createTurnstileCheck('secret', reply({}, false))('token')).toBe(false)
  })

  it('fails without a token, and when Cloudflare can’t be reached', async () => {
    const never = reply({ success: true })
    expect(await createTurnstileCheck('secret', never)(undefined)).toBe(false)
    expect(never).not.toHaveBeenCalled()
    const down = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await createTurnstileCheck('secret', down)('token')).toBe(false)
  })
})

describe.skipIf(!TEST_DATABASE_URL)('sign-up through the API (R1.01) and the bot check', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    // The fake check accepts the token "human" only.
    t = testApp(sql, { humanCheck: async (token) => token === 'human' })
    req = client(t.app)
  })
  afterAll(async () => {
    await drop?.()
  })

  const body = { fullName: 'Ada  Obi', email: ' Ada@ALIWA.org ', password: 'a-strong-password', captchaToken: 'human' }

  it('refuses without a passing bot check, and creates nothing', async () => {
    const res = await req('POST', '/v1/auth/sign-up', { body: { ...body, captchaToken: 'bot' } })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: { code: 'captcha_failed' } })
    expect(await sql`select 1 from auth.users`).toHaveLength(0)
  })

  it('validates the form', async () => {
    const res = await req('POST', '/v1/auth/sign-up', { body: { ...body, fullName: 'Ada', password: 'short' } })
    expect(res.status).toBe(400)
  })

  it('creates the account and emails a Synqop confirmation link that leads to organisation setup', async () => {
    const res = await req('POST', '/v1/auth/sign-up', { body })
    expect(res.status).toBe(201)
    expect(t.auth.signupLinks.at(-1)).toEqual({ email: 'ada@aliwa.org', name: 'Ada Obi', redirectTo: 'http://localhost:5173/signup/organisation' })
    const email = t.mail.sent.at(-1)!
    expect(email).toMatchObject({ to: 'ada@aliwa.org', subject: 'Confirm your email for Synqop' })
    expect(email.text).toContain('Hi Ada,')
    // The link opens Synqop, which checks the token, then continues to organisation set-up.
    expect(email.html).toContain('/auth/confirm?token_hash=fake-hash&amp;type=signup&amp;next=%2Fsignup%2Forganisation')
  })

  it('says on screen when the email already has an account, and sends nothing (pilot feedback)', async () => {
    const sent = t.mail.sent.length
    const res = await req('POST', '/v1/auth/sign-up', { body })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'account_exists', details: [{ field: 'email' }] })
    expect(t.mail.sent.length).toBe(sent)
    expect(await sql`select 1 from auth.users`).toHaveLength(1)
  })

  it('also checks for bots on forgot password', async () => {
    const sent = t.mail.sent.length
    const bot = await req('POST', '/v1/auth/password-reset', { body: { email: 'ada@aliwa.org' } })
    expect(bot.status).toBe(400)
    expect(bot.body).toMatchObject({ error: { code: 'captcha_failed' } })
    const human = await req('POST', '/v1/auth/password-reset', { body: { email: 'ada@aliwa.org', captchaToken: 'human' } })
    expect(human.status).toBe(202)
    expect(t.mail.sent.length).toBe(sent + 1)
  })
})
