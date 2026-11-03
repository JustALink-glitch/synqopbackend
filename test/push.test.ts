import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { flushPush, type PushResult, type PushSender } from '../src/lib/push.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

describe.skipIf(!TEST_DATABASE_URL)('web push (G1.01)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let trainerToken: string
  let trainerId: string
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = []
  const answers = new Map<string, PushResult>()
  const push: PushSender = {
    publicKey: 'BTestPublicKey',
    send: async (s, payload) => {
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) })
      return answers.get(s.endpoint) ?? 'sent'
    },
  }
  const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `key${n}`, auth: `auth${n}` } })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql, { push })
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await req('POST', '/v1/organisations', { token, body: { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' } })
    trainerId = (
      (await req('POST', '/v1/members', { token, body: { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' } })).body.member as { id: string }
    ).id
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    const [row] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${trainerId}`
    trainerToken = as(row!.user_id, 'ngozi@aliwa.org')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('gives browsers the public key and saves each device', async () => {
    expect((await req('GET', '/v1/notifications/push/key', { token })).body).toEqual({ publicKey: 'BTestPublicKey' })
    expect(
      (await req('PUT', '/v1/notifications/push/subscription', { token, body: { endpoint: 'http://insecure.example/1', keys: sub(1).keys } })).status,
    ).toBe(400)
    expect((await req('PUT', '/v1/notifications/push/subscription', { token, body: sub(1) })).status).toBe(200)
    expect((await req('PUT', '/v1/notifications/push/subscription', { token: trainerToken, body: sub(2) })).status).toBe(200)
    expect((await req('PUT', '/v1/notifications/push/subscription', { token: trainerToken, body: sub(3) })).status).toBe(200)
    // The same device again only updates it.
    expect((await req('PUT', '/v1/notifications/push/subscription', { token: trainerToken, body: sub(3) })).status).toBe(200)
    expect(await sql`select 1 from push_subscriptions`).toHaveLength(3)
  })

  it('sends a test push to this device only', async () => {
    sent.length = 0
    expect((await req('POST', '/v1/notifications/push/test', { token, body: { endpoint: sub(2).endpoint } })).status).toBe(404)
    const res = await req('POST', '/v1/notifications/push/test', { token: trainerToken, body: { endpoint: sub(2).endpoint } })
    expect(res.body).toEqual({ result: 'sent' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ endpoint: sub(2).endpoint, payload: { title: 'Synqop notifications are on' } })
    sent.length = 0
  })

  it('pushes new bell notifications once, to the right person, and forgets dead devices', async () => {
    // The joining notice for Ngozi went to the owner's bell when she accepted; it predates push being on for nobody.
    await sql`update notifications set pushed_at = now()`
    await sql`
      insert into notifications (organisation_id, recipient_member_id, event, title, body, link_path)
      select organisation_id, id, 'report_due', 'Session report due', 'Python · Today', '/trainer/reports' from organisation_members where id = ${trainerId}
    `
    // Old news isn't pushed.
    await sql`
      insert into notifications (organisation_id, recipient_member_id, event, title, link_path, created_at)
      select organisation_id, id, 'report_due', 'Old', '/trainer/reports', now() - interval '2 hours' from organisation_members where id = ${trainerId}
    `
    answers.set('https://push.example/3', 'gone')
    expect(await flushPush({ sql, push })).toBe(1)
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/2', 'https://push.example/3'])
    expect(sent[0]!.payload).toMatchObject({ title: 'Session report due', body: 'Python · Today', link: '/trainer/reports', unread: 2 })
    expect((await sql<{ endpoint: string }[]>`select endpoint from push_subscriptions order by endpoint`).map((r) => r.endpoint)).toEqual([
      'https://push.example/1',
      'https://push.example/2',
    ])
    sent.length = 0
    expect(await flushPush({ sql, push })).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('moves a device to whoever signs in on it, and removes it on request', async () => {
    await req('PUT', '/v1/notifications/push/subscription', { token: trainerToken, body: sub(1) })
    expect((await sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where member_id = ${trainerId}`)[0]!.n).toBe(2)
    // Someone else can't remove Ngozi's device.
    await req('DELETE', '/v1/notifications/push/subscription', { token, body: { endpoint: sub(1).endpoint } })
    expect(await sql`select 1 from push_subscriptions where endpoint = ${sub(1).endpoint}`).toHaveLength(1)
    expect((await req('DELETE', '/v1/notifications/push/subscription', { token: trainerToken, body: { endpoint: sub(1).endpoint } })).status).toBe(204)
    expect(await sql`select 1 from push_subscriptions where endpoint = ${sub(1).endpoint}`).toHaveLength(0)
  })
})
