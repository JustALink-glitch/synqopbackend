import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

/** Fixes from the first pilot test round (Nov 2026). */
describe.skipIf(!TEST_DATABASE_URL)('pilot test fixes', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let t: ReturnType<typeof testApp>
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  let trainerToken: string
  let participantToken: string
  let cohortId: string
  let courseIds: string[]
  let trainerId: string
  let participantId: string

  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const get = (path: string, token = adminToken) => req('GET', path, { token })
  const put = (path: string, body: unknown, token = adminToken) => req('PUT', path, { token, body })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    courseIds = []
    for (const name of ['Python', 'SQL']) courseIds.push(((await post('/v1/courses', { programmeId, name })).body.course as { id: string }).id)
    cohortId = (
      (await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-10), endsOn: day(60), deliveryMode: 'online', courseIds })).body.cohort as {
        id: string
      }
    ).id
    participantId = ((await post('/v1/participants', { fullName: 'Chidi Nwosu', email: 'chidi@example.com', cohortId })).body.participant as { id: string }).id
    const pUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${pUser}, 'chidi@example.com')`
    await sql`update organisation_members set user_id = ${pUser}, status = 'active' where id = ${participantId}`
    participantToken = as(pUser, 'chidi@example.com')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('assigns cohorts straight from the trainer invitation, as lead', async () => {
    const res = await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer', assignments: [{ cohortId }] })
    expect(res.status).toBe(201)
    trainerId = (res.body.member as { id: string }).id
    const rows = await sql<{ is_lead: boolean }[]>`select is_lead from cohort_course_trainers where member_id = ${trainerId}`
    expect(rows).toEqual([{ is_lead: true }, { is_lead: true }])
    const user = randomUUID()
    await sql`insert into auth.users (id, email) values (${user}, 'ngozi@aliwa.org')`
    await sql`update organisation_members set user_id = ${user}, status = 'active' where id = ${trainerId}`
    trainerToken = as(user, 'ngozi@aliwa.org')
  })

  it('invites an assistant as assistant, and refuses when assistants are off', async () => {
    await sql`update organisation_settings set assistants_enabled = false`
    const off = await post('/v1/members', { email: 'tolu@aliwa.org', fullName: 'Tolu Ade', role: 'assistant_trainer', assignments: [{ cohortId }] })
    expect(off.body.error).toMatchObject({ code: 'assistants_off' })
    expect(await sql`select 1 from organisation_members where email = 'tolu@aliwa.org'`).toHaveLength(0)
    await sql`update organisation_settings set assistants_enabled = true`
    const on = await post('/v1/members', {
      email: 'tolu@aliwa.org',
      fullName: 'Tolu Ade',
      role: 'assistant_trainer',
      assignments: [{ cohortId, courseId: courseIds[0] }],
    })
    expect(on.status).toBe(201)
    const rows = await sql`select is_lead from cohort_course_trainers where member_id = ${(on.body.member as { id: string }).id}`
    expect(rows).toEqual([{ is_lead: false }])
    // Only trainers can be given cohorts.
    expect((await post('/v1/members', { email: 'x@aliwa.org', fullName: 'X Y', role: 'admin', assignments: [{ cohortId }] })).status).toBe(400)
  })

  it('assigns every course when trainers are assigned to whole cohorts', async () => {
    const other = ((await post('/v1/members', { email: 'femi@aliwa.org', fullName: 'Femi Lawal', role: 'trainer' })).body.member as { id: string }).id
    await sql`update organisation_settings set trainer_assignment = 'cohort'`
    const res = await post(`/v1/members/${other}/assignments`, { cohortId, courseId: courseIds[0], role: 'lead' })
    expect(res.body).toMatchObject({ course: '2 courses', courses: ['Python', 'SQL'] })
    await sql`update organisation_settings set trainer_assignment = 'course'`
    // Put Ngozi back as lead for the resource tests.
    await post(`/v1/members/${trainerId}/assignments`, { cohortId, role: 'lead' })
  })

  it('serves profile photos for lists; participants only see staff and themselves', async () => {
    await sql`update organisation_members set photo_path = 'org/photos/p.jpg' where id = ${participantId}`
    await sql`update organisation_members set photo_path = 'org/photos/t.jpg' where id = ${trainerId}`
    const otherParticipant = (
      (await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId })).body.participant as { id: string }
    ).id
    await sql`update organisation_members set photo_path = 'org/photos/a.jpg' where id = ${otherParticipant}`
    const asAdmin = await post('/v1/photos', { ids: [participantId, trainerId, otherParticipant] })
    expect(Object.keys(asAdmin.body.photos as object).sort()).toEqual([participantId, trainerId, otherParticipant].sort())
    const asParticipant = await post('/v1/photos', { ids: [participantId, trainerId, otherParticipant] }, participantToken)
    expect(Object.keys(asParticipant.body.photos as object).sort()).toEqual([participantId, trainerId].sort())
  })

  it('lets a trainer add, list and remove resources for a whole course without a session', async () => {
    const cc = (await sql<{ id: string }[]>`select id from cohort_courses where course_id = ${courseIds[0]!}`)[0]!.id
    const empty = await get(`/v1/cohort-courses/${cc}/resources`, trainerToken)
    expect(empty.body).toMatchObject({ canAdd: true, resources: [] })
    const added = await post(`/v1/cohort-courses/${cc}/resources`, { kind: 'link', name: 'Course notes', url: 'https://example.com/notes' }, trainerToken)
    expect(added.status).toBe(201)
    const list = await get(`/v1/cohort-courses/${cc}/resources`, trainerToken)
    expect(list.body.resources).toMatchObject([{ name: 'Course notes', wholeCourse: true, canRemove: true, library: false }])
    // Participants see it on the course.
    const mine = await get(`/v1/my/courses/${cc}`, participantToken)
    expect(JSON.stringify(mine.body)).toContain('Course notes')
    // Participants can't use the staff route.
    expect((await get(`/v1/cohort-courses/${cc}/resources`, participantToken)).status).toBe(403)
    const id = (list.body.resources as { id: string }[])[0]!.id
    expect((await req('DELETE', `/v1/cohort-courses/${cc}/resources/${id}`, { token: trainerToken })).status).toBe(204)
  })

  it('keeps programme setup changes live: no "new programmes only"', async () => {
    const s = (await get('/v1/settings/programme-setup')).body.settings as Record<string, unknown>
    expect((await put('/v1/settings/programme-setup', { ...s, multiCohort: true })).status).toBe(200)
    expect((await get('/v1/settings/programme-setup')).body.settings).toMatchObject({ multiCohort: true })
  })

  it('stores an organisation logo and shows it to everyone in /me', async () => {
    const up = await post('/v1/settings/organisation/logo/upload', { type: 'image/png', size: 2000 })
    const path = (up.body.upload as { path: string }).path
    expect((await post('/v1/settings/organisation/logo/upload', { type: 'image/svg+xml', size: 10 })).status).toBe(400)
    t.files.put(path, 2000, 'image/png')
    expect((await put('/v1/settings/organisation/logo', { path })).status).toBe(200)
    expect(((await get('/v1/me', participantToken)).body.organisation as { logoUrl: string }).logoUrl).toContain(path)
    expect((await put('/v1/settings/organisation/logo', { path }, trainerToken)).status).toBe(403)
    expect((await req('DELETE', '/v1/settings/organisation/logo', { token: adminToken })).status).toBe(204)
    expect(((await get('/v1/me')).body.organisation as { logoUrl: string | null }).logoUrl).toBeNull()
  })

  it('transfers ownership to an active admin only, and emails both', async () => {
    const pending = ((await post('/v1/members', { email: 'bola@aliwa.org', fullName: 'Bola Ige', role: 'admin' })).body.member as { id: string }).id
    expect((await post(`/v1/members/${pending}/transfer-ownership`, {})).body.error).toMatchObject({ code: 'not_admin' })
    expect((await post(`/v1/members/${trainerId}/transfer-ownership`, {})).body.error).toMatchObject({ code: 'not_admin' })
    const user = randomUUID()
    await sql`insert into auth.users (id, email) values (${user}, 'bola@aliwa.org')`
    await sql`update organisation_members set user_id = ${user}, status = 'active' where id = ${pending}`
    const bola = as(user, 'bola@aliwa.org')
    // Admins can't do it.
    expect((await post(`/v1/members/${pending}/transfer-ownership`, {}, bola)).status).toBe(403)
    const sent = t.mail.sent.length
    const res = await post(`/v1/members/${pending}/transfer-ownership`, {})
    expect(res.body).toMatchObject({ owner: { name: 'Bola Ige' } })
    expect(await sql`select email, role from organisation_members where role in ('owner', 'admin') order by email`).toEqual([
      { email: 'ada@aliwa.org', role: 'admin' },
      { email: 'bola@aliwa.org', role: 'owner' },
    ])
    expect(
      t.mail.sent
        .slice(sent)
        .map((m) => m.to)
        .sort(),
    ).toEqual(['ada@aliwa.org', 'bola@aliwa.org'])
    // Give it back for the remaining tests.
    const adaId = (await sql<{ id: string }[]>`select id from organisation_members where email = 'ada@aliwa.org'`)[0]!.id
    expect((await post(`/v1/members/${adaId}/transfer-ownership`, {}, bola)).status).toBe(200)
  })

  it('deletes a cohort, course or programme permanently only while nothing is recorded', async () => {
    const programmeId = ((await post('/v1/programmes', { name: 'Throwaway' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Typo course' })).body.course as { id: string }).id
    const cohort = (
      (await post('/v1/cohorts', { programmeId, name: 'Mistake', startsOn: day(5), endsOn: day(40), deliveryMode: 'online', courseIds: [courseId] })).body
        .cohort as { id: string }
    ).id
    await post('/v1/participants', { fullName: 'Kemi Bello', email: 'kemi@example.com', cohortId: cohort })
    const cc = (await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${cohort}`)[0]!.id
    await post('/v1/assignments', {
      cohortCourseId: cc,
      title: 'Draft',
      dueDate: day(10),
      dueTime: '23:59',
      submissionTypes: ['link'],
      latePolicy: 'accept_late',
      gradingScale: 'points',
      maxPoints: 10,
      publish: false,
    })

    const check = await get(`/v1/cohorts/${cohort}/delete-check`)
    expect(check.body).toMatchObject({ name: 'Mistake', deletable: true, recorded: [], removes: { participants: 1, assignments: 1 } })
    // Trainers can't.
    expect((await req('DELETE', `/v1/cohorts/${cohort}`, { token: trainerToken })).status).toBe(403)

    // The real cohort has records once attendance is taken: archive only.
    const session = (
      await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'Week 1', now() - interval '2 hours', now() - interval '1 hour' from cohort_courses where cohort_id = ${cohortId} limit 1 returning id
    `
    )[0]!.id
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source) select organisation_id, ${session}, ${participantId}, 'present', 'manual' from sessions where id = ${session}`
    const real = await get(`/v1/cohorts/${cohortId}/delete-check`)
    expect(real.body).toMatchObject({ deletable: false, recorded: ['attendance'] })
    expect((await req('DELETE', `/v1/cohorts/${cohortId}`, { token: adminToken })).body.error).toMatchObject({ code: 'has_records' })

    expect((await req('DELETE', `/v1/cohorts/${cohort}`, { token: adminToken })).status).toBe(204)
    expect(await sql`select 1 from cohorts where id = ${cohort}`).toHaveLength(0)
    expect(await sql`select 1 from enrolments e join organisation_members m on m.id = e.member_id where m.email = 'kemi@example.com'`).toHaveLength(0)
    expect((await req('DELETE', `/v1/courses/${courseId}`, { token: adminToken })).status).toBe(204)
    expect((await req('DELETE', `/v1/programmes/${programmeId}`, { token: adminToken })).status).toBe(204)
    expect(await sql`select 1 from programmes where id = ${programmeId}`).toHaveLength(0)
    // The programme with recorded attendance can't go.
    const main = (await sql<{ programme_id: string }[]>`select programme_id from cohorts where id = ${cohortId}`)[0]!.programme_id
    expect((await req('DELETE', `/v1/programmes/${main}`, { token: adminToken })).status).toBe(409)
  })
})
