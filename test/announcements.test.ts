import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)
type Item = { id: string; title: string; audience: string; important: boolean; author: { name: string } | null; can: { edit: boolean } }

describe.skipIf(!TEST_DATABASE_URL)('announcements (G1.03)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  const tk: Record<string, string> = {}
  const ids: Record<string, string> = {}

  async function tokenFor(email: string) {
    const [row] = await sql<{ user_id: string }[]>`select user_id from organisation_members where email = ${email}`
    return as(row!.user_id, email)
  }
  const bellOf = (email: string) => sql<{ title: string; link_path: string }[]>`
    select n.title, n.link_path from notifications n join organisation_members m on m.id = n.recipient_member_id where m.email = ${email} and n.event = 'announcement' order by n.created_at`

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    tk.ada = as(owner.id, owner.email)
    const post = (path: string, body: unknown) => req('POST', path, { token: tk.ada, body })
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const course = ((await post('/v1/courses', { programmeId: programme, name: 'Python' })).body.course as { id: string }).id
    ids.c5 = (
      (
        await post('/v1/cohorts', {
          programmeId: programme,
          name: 'Cohort 5',
          startsOn: day(-20),
          endsOn: day(60),
          deliveryMode: 'online',
          courseIds: [course],
        })
      ).body.cohort as { id: string }
    ).id
    ids.c6 = (
      (await post('/v1/cohorts', { programmeId: programme, name: 'Cohort 6', startsOn: day(-5), endsOn: day(60), deliveryMode: 'online', courseIds: [course] }))
        .body.cohort as { id: string }
    ).id
    await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer', assignments: [{ cohortId: ids.c5 }] })
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    for (const [name, email, cohort] of [
      ['Chidi Nwosu', 'chidi@example.com', ids.c5],
      ['Bisi Ade', 'bisi@example.com', ids.c6],
    ] as const) {
      await post('/v1/participants', { fullName: name, email, cohortId: cohort })
      await req('POST', `/v1/invitations/${t.mail.lastToken(email)}/accept`, { body: { password: 'a-strong-password' } })
    }
    tk.ngozi = await tokenFor('ngozi@aliwa.org')
    tk.chidi = await tokenFor('chidi@example.com')
    tk.bisi = await tokenFor('bisi@example.com')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lets admins post to everyone, with the bell for all but the author and email only when important', async () => {
    t.mail.sent.length = 0
    const res = await req('POST', '/v1/announcements', {
      token: tk.ada,
      body: { title: 'Holiday on Friday', body: 'No sessions on Friday.\nSee you Monday.', audience: 'everyone' },
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ reached: 3, emailed: 0 })
    expect(t.mail.sent).toHaveLength(0)
    const id = (res.body.announcement as Item).id
    expect(await bellOf('chidi@example.com')).toEqual([{ title: 'Ada Obi: Holiday on Friday', link_path: `/participant/announcements#${id}` }])
    expect(await bellOf('ngozi@aliwa.org')).toEqual([{ title: 'Ada Obi: Holiday on Friday', link_path: `/trainer/announcements#${id}` }])
    expect(await bellOf('ada@aliwa.org')).toEqual([])
    const important = await req('POST', '/v1/announcements', {
      token: tk.ada,
      body: { title: 'Venue change', body: 'We move to Lab 3.', audience: 'participants', important: true },
    })
    expect(important.body).toMatchObject({ reached: 2, emailed: 2 })
    expect(t.mail.sent.map((m) => m.to).sort()).toEqual(['bisi@example.com', 'chidi@example.com'])
    expect(t.mail.sent[0]!.text).toContain('We move to Lab 3.')
  })

  it('keeps trainers to the cohorts they teach and participants to reading', async () => {
    const list = await req('GET', '/v1/announcements', { token: tk.ngozi })
    expect(list.body).toMatchObject({ canPost: true, audiences: ['cohort'], cohorts: [{ id: ids.c5, name: 'Cohort 5' }] })
    expect((await req('POST', '/v1/announcements', { token: tk.ngozi, body: { title: 'Hi', body: 'All', audience: 'everyone' } })).status).toBe(403)
    const other = await req('POST', '/v1/announcements', { token: tk.ngozi, body: { title: 'Hi', body: 'C6', audience: 'cohort', cohortId: ids.c6 } })
    expect(other.body.error!.details).toEqual([{ field: 'cohortId', message: 'Choose one of your cohorts.' }])
    const ok = await req('POST', '/v1/announcements', {
      token: tk.ngozi,
      body: { title: 'Bring laptops', body: 'Tomorrow we code.', audience: 'cohort', cohortId: ids.c5 },
    })
    expect(ok.body).toMatchObject({ reached: 2 }) // Chidi and Ada, not Bisi.
    expect((await bellOf('bisi@example.com')).map((n) => n.title)).not.toContain('Ngozi Eze: Bring laptops')
    expect((await req('POST', '/v1/announcements', { token: tk.chidi, body: { title: 'x', body: 'y', audience: 'cohort', cohortId: ids.c5 } })).status).toBe(
      403,
    )
    expect((await req('GET', '/v1/announcements', { token: tk.chidi })).body).toMatchObject({ canPost: false, audiences: [] })
  })

  it('shows each person what was addressed to them', async () => {
    await req('POST', '/v1/announcements', { token: tk.ada, body: { title: 'Staff meeting', body: 'Thursday 4pm.', audience: 'staff' } })
    const titles = async (token: string | undefined) => ((await req('GET', '/v1/announcements', { token })).body.announcements as Item[]).map((a) => a.title)
    expect(await titles(tk.chidi)).toEqual(['Bring laptops', 'Venue change', 'Holiday on Friday'])
    expect(await titles(tk.bisi)).toEqual(['Venue change', 'Holiday on Friday'])
    expect(await titles(tk.ngozi)).toEqual(['Staff meeting', 'Bring laptops', 'Holiday on Friday'])
    expect(await titles(tk.ada)).toHaveLength(4)
  })

  it('counts new announcements until each person marks them read', async () => {
    expect((await req('GET', '/v1/announcements/unread', { token: tk.chidi })).body).toEqual({ unread: 3 })
    // Your own posts are never "new" to you.
    expect((await req('GET', '/v1/announcements/unread', { token: tk.ngozi })).body).toEqual({ unread: 2 })
    const list = (await req('GET', '/v1/announcements', { token: tk.chidi })).body as { unread: number; announcements: (Item & { read: boolean })[] }
    expect(list.unread).toBe(3)
    const first = list.announcements[0]!
    expect((await req('POST', `/v1/announcements/${first.id}/read`, { token: tk.chidi })).body).toEqual({ unread: 2 })
    // Marking it read also clears it from the bell.
    const [n] = await sql<{ read_at: Date | null }[]>`
      select n.read_at from notifications n join organisation_members m on m.id = n.recipient_member_id where m.email = 'chidi@example.com' and n.link_path like ${'%#' + first.id}`
    expect(n!.read_at).not.toBeNull()
    // Bisi's count is her own.
    expect((await req('GET', '/v1/announcements/unread', { token: tk.bisi })).body).toEqual({ unread: 2 })
    expect((await req('DELETE', `/v1/announcements/${first.id}/read`, { token: tk.chidi })).body).toEqual({ unread: 3 })
    expect((await req('POST', '/v1/announcements/read-all', { token: tk.chidi })).body).toEqual({ unread: 0 })
    expect(((await req('GET', '/v1/announcements', { token: tk.chidi })).body.announcements as { read: boolean }[]).every((x) => x.read)).toBe(true)
  })

  it('records who has seen each one, shown only to the author and admins', async () => {
    type Seen = Item & { seenBy: { count: number; recent: { name: string }[] } | null }
    const of = async (token: string | undefined) => (await req('GET', '/v1/announcements', { token })).body.announcements as Seen[]
    const holiday = (await of(tk.ada)).find((a) => a.title === 'Holiday on Friday')!
    const laptops = (await of(tk.ada)).find((a) => a.title === 'Bring laptops')!
    // Bisi can only be counted on what was addressed to her; repeats count once.
    expect((await req('POST', '/v1/announcements/seen', { token: tk.bisi, body: { ids: [holiday.id, laptops.id, holiday.id] } })).status).toBe(204)
    expect((await req('POST', '/v1/announcements/seen', { token: tk.bisi, body: { ids: [holiday.id] } })).status).toBe(204)
    const [{ n }] = (await sql`select count(*)::int as n from announcement_views v join organisation_members m on m.id = v.member_id
      where m.email = 'bisi@example.com'`) as unknown as [{ n: number }]
    expect(n).toBe(1)
    // Chidi marked everything read earlier, which also counts as seen.
    const ngozi = (await of(tk.ngozi)).find((a) => a.id === laptops.id)!
    expect(ngozi.seenBy).toMatchObject({ count: 1, recent: [{ name: 'Chidi Nwosu' }] })
    expect((await of(tk.ngozi)).find((a) => a.id === holiday.id)!.seenBy).toBeNull()
    expect((await of(tk.chidi)).every((a) => a.seenBy === null)).toBe(true)
    expect((await of(tk.ada)).find((a) => a.id === holiday.id)!.seenBy!.count).toBe(2)
    const views = await req('GET', `/v1/announcements/${laptops.id}/views`, { token: tk.ngozi })
    expect(views.body).toMatchObject({ seen: [{ name: 'Chidi Nwosu', role: 'participant' }], notSeen: [{ name: 'Ada Obi', role: 'owner' }] })
    expect((await req('GET', `/v1/announcements/${laptops.id}/views`, { token: tk.chidi })).status).toBe(403)
    expect((await req('GET', `/v1/announcements/${holiday.id}/views`, { token: tk.ada })).body).toMatchObject({
      seen: [{ name: expect.any(String) }, { name: expect.any(String) }],
      notSeen: [{ name: 'Ngozi Eze' }],
    })
  })

  it('lets the author or an admin edit and delete, and deleting clears the bell', async () => {
    const mine = ((await req('GET', '/v1/announcements', { token: tk.chidi })).body.announcements as Item[]).find((a) => a.title === 'Bring laptops')!
    expect(mine.can.edit).toBe(false)
    expect((await req('PATCH', `/v1/announcements/${mine.id}`, { token: tk.chidi, body: { title: 'x', body: 'y' } })).status).toBe(403)
    const edited = await req('PATCH', `/v1/announcements/${mine.id}`, {
      token: tk.ngozi,
      body: { title: 'Bring laptops and chargers', body: 'Tomorrow we code.' },
    })
    expect((edited.body.announcement as Item).title).toBe('Bring laptops and chargers')
    expect((await req('DELETE', `/v1/announcements/${mine.id}`, { token: tk.ada })).status).toBe(204)
    expect((await bellOf('chidi@example.com')).some((n) => n.link_path.endsWith(mine.id))).toBe(false)
    expect((await req('GET', '/v1/announcements', { token: tk.chidi })).body.announcements as Item[]).toHaveLength(2)
  })
})
