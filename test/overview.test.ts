import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('programme overview (O1.01)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  const post = (path: string, body: unknown) => req('POST', path, { token, body })
  const get = (path: string) => req('GET', path, { token })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    token = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
  })

  afterAll(async () => {
    await drop?.()
  })

  it('shows set-up progress before there are cohorts (O1.01e)', async () => {
    const res = await get('/v1/overview')
    expect(res.body).toMatchObject({
      programmes: 0,
      cohorts: { active: 0, upcoming: 0 },
      attendance: { rate: null },
      setup: { organisation: true, programme: false, cohort: false, session: false, admins: 1 },
    })
    expect((res.body.activity as unknown[]).length).toBe(8)
  })

  it('adds up delivery, attendance and flags across cohorts', async () => {
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python' })).body.course as { id: string }).id
    const cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    await post('/v1/cohorts', { programmeId, name: 'Cohort 6', startsOn: day(30), endsOn: day(90), deliveryMode: 'online', courseIds: [courseId] })
    const people: string[] = []
    for (const n of ['Amara Okafor', 'Bayo Ade']) people.push(((await post('/v1/participants', { fullName: n, email: `${n.split(' ')[0]}@example.com`, cohortId })).body.participant as { id: string }).id)
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'x', now() - interval '26 hours', now() - interval '24 hours' from cohort_courses where cohort_id = ${cohortId} returning id
    `
    await req('PUT', `/v1/sessions/${s!.id}/attendance`, { token, body: { marks: [{ memberId: people[0], status: 'present' }, { memberId: people[1], status: 'excused' }] } })
    await sql`insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at) select organisation_id, id, 'x', now() + interval '2 days', now() + interval '2 days 2 hours' from cohort_courses where cohort_id = ${cohortId}`
    const res = await get('/v1/overview')
    expect(res.body).toMatchObject({
      programmes: 1,
      cohorts: { active: 1, upcoming: 1 },
      participants: 2,
      attendance: { rate: 50, present: 1, recorded: 2, previous: null },
      setup: { programme: true, cohort: true, participants: true, courses: true, session: true },
    })
    const weeks = res.body.activity as { present: number; excused: number }[]
    expect(weeks.reduce((n, w) => n + w.present + w.excused, 0)).toBe(2)
    expect(Object.keys(res.body.nextSessions as object)).toEqual([cohortId])
  })

  it('shows training activity weekly, monthly, yearly or for chosen dates', async () => {
    type Activity = { unit: string; buckets: { start: string; present: number; excused: number; rate: number | null }[] }
    const total = (a: Activity) => a.buckets.reduce((n, b) => n + b.present + b.excused, 0)
    const week = (await get('/v1/overview/activity?period=week')).body as Activity
    expect(week).toMatchObject({ unit: 'week' })
    expect(week.buckets).toHaveLength(8)
    expect(total(week)).toBe(2)
    const month = (await get('/v1/overview/activity?period=month')).body as Activity
    expect(month.buckets).toHaveLength(12)
    expect(month.buckets.every((b) => b.start.endsWith('-01'))).toBe(true)
    expect(total(month)).toBe(2)
    const year = (await get('/v1/overview/activity?period=year')).body as Activity
    expect(year.buckets).toHaveLength(5)
    expect(total(year)).toBe(2)
    const days = (await get(`/v1/overview/activity?period=custom&from=${day(-6)}&to=${day(0)}`)).body as Activity
    expect(days.unit).toBe('day')
    expect(days.buckets).toHaveLength(7)
    expect(total(days)).toBe(2)
    expect(days.buckets.find((b) => b.present)!.rate).toBe(50)
    const none = (await get(`/v1/overview/activity?period=custom&from=${day(-90)}&to=${day(-30)}`)).body as Activity
    expect(none.unit).toBe('week')
    expect(total(none)).toBe(0)
    expect((await get('/v1/overview/activity?period=custom&from=2026-01-01')).status).toBe(400)
  })
})
