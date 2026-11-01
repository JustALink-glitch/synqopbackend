import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

describe.skipIf(!TEST_DATABASE_URL)('two-step sign-in is enforced by the API', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    await req('POST', '/v1/organisations', { token: as(owner.id, owner.email), body: { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' } })
  })
  afterAll(async () => {
    await drop?.()
  })

  it('needs only a password while two-step sign-in is off', async () => {
    expect((await req('GET', '/v1/me', { token: as(owner.id, owner.email) })).status).toBe(200)
  })

  it('ignores a set-up that was never finished', async () => {
    await sql`insert into auth.mfa_factors (user_id, status) values (${owner.id}, 'unverified')`
    expect((await req('GET', '/v1/me', { token: as(owner.id, owner.email) })).status).toBe(200)
  })

  it('once it is on, refuses a password-only session everywhere, and accepts a session that passed the code', async () => {
    await sql`update auth.mfa_factors set status = 'verified' where user_id = ${owner.id}`
    for (const path of ['/v1/me', '/v1/programmes', '/v1/settings/attendance']) {
      const res = await req('GET', path, { token: as(owner.id, owner.email) })
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: { code: 'mfa_required' } })
    }
    expect((await req('POST', '/v1/programmes', { token: as(owner.id, owner.email), body: { name: 'Sneaky' } })).status).toBe(403)
    expect((await req('GET', '/v1/me', { token: as(owner.id, owner.email, 'aal2') })).status).toBe(200)
    expect((await req('POST', '/v1/programmes', { token: as(owner.id, owner.email, 'aal2'), body: { name: 'Data & AI' } })).status).toBe(201)
  })
})
