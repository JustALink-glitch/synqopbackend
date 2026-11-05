import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { syncZoom, syncZoomQueued, zoomSoon, type ZoomSyncDeps } from '../src/lib/zoom-sync.js'
import { tokenBox, ZoomError, type MeetingInput, type ZoomApi, type ZoomParticipant, type ZoomRecording, type ZoomUser } from '../src/lib/zoom.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

/** A Zoom stand-in that records what Synqop asked for. */
function fakeZoom() {
  const calls: string[] = []
  const meetings = new Map<string, MeetingInput>()
  const reports = new Map<string, ZoomParticipant[] | null>()
  const recordings = new Map<string, ZoomRecording>()
  const users: ZoomUser[] = []
  let n = 0
  let refreshes = 0
  let failWith: ZoomError | null = null
  const check = () => {
    if (failWith) throw failWith
  }
  const api: ZoomApi = {
    authorizeUrl: (state) => `https://zoom.us/oauth/authorize?state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      if (code !== 'good-code') throw new ZoomError(400, 'invalid_request', 'Bad code')
      return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, scopes: ['meeting:write:meeting'] }
    },
    async refresh(token) {
      check()
      refreshes++
      return { accessToken: `access-r${refreshes}`, refreshToken: `${token}-r${refreshes}`, expiresIn: 3600, scopes: [] }
    },
    async revoke() {
      calls.push('revoke')
    },
    async me() {
      return { email: 'zoom@aliwa.org', accountId: 'acc-1' }
    },
    async createMeeting(_t, input) {
      check()
      const id = String(++n)
      meetings.set(id, input)
      calls.push(`create ${id}`)
      return { id, joinUrl: `https://zoom.us/j/${id}` }
    },
    async updateMeeting(_t, id, input) {
      check()
      meetings.set(id, input)
      calls.push(`update ${id}`)
    },
    async deleteMeeting(_t, id) {
      check()
      meetings.delete(id)
      calls.push(`delete ${id}`)
    },
    async users() {
      check()
      calls.push('users')
      return users
    },
    async startUrl(_t, id) {
      check()
      return `https://zoom.us/s/${id}?zak=host-token`
    },
    async recording(_t, id) {
      check()
      return recordings.get(id) ?? null
    },
    async addRegistrant(_t, id, person) {
      check()
      calls.push(`register ${id} ${person.email}`)
      return { registrantId: `r-${person.email}`, joinUrl: `https://zoom.us/w/${id}?tk=${person.email}` }
    },
    async participants(_t, id) {
      check()
      return reports.has(id) ? reports.get(id)! : null
    },
  }
  return {
    api,
    calls,
    meetings,
    reports,
    recordings,
    users,
    get refreshes() {
      return refreshes
    },
    fail(e: ZoomError | null) {
      failWith = e
    },
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Zoom (F1.07, C1.02, C2.01, C2.04)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  const zoom = fakeZoom()
  const box = tokenBox('zoom-client-secret-for-tests')
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  let deps: ZoomSyncDeps
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let chidiToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown, tk = token) => req('POST', path, { token: tk, body })
  const get = (path: string, tk = token) => req('GET', path, { token: tk })
  const sync = (now = new Date()) => syncZoom(deps, ids.org!, now)
  const at = (h: number) => new Date(Date.now() + h * 3_600_000)

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql, { zoom: zoom.api, zoomBox: box })
    req = client(t.app)
    deps = { sql, mailer: t.mail.mailer, appUrl: 'http://localhost:5173', zoom: zoom.api, box }
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const [org] = await sql<{ id: string }[]>`select id from organisations`
    ids.org = org!.id
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    ids.trainer = trainer.id
    const programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.course = ((await post('/v1/courses', { programmeId: programme, name: 'Python for Data Analysis', defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.course] })).body
      .cohort as { id: string }).id
    for (const [key, name, email] of [
      ['chidi', 'Chidi Nwosu', 'chidi@example.com'],
      ['amara', 'Amara Okafor', 'amara@example.com'],
      ['tobi', 'Tobi Adewale', 'tobi@example.com'],
      ['bisi', 'Bisi Ade', 'bisi@example.com'],
    ] as const) {
      ids[key] = ((await post('/v1/participants', { fullName: name, email, cohortId: ids.cohort })).body.participant as { id: string }).id
    }
    await req('POST', `/v1/invitations/${t.mail.lastToken('chidi@example.com')}/accept`, { body: { password: 'a-strong-password' } })
    const [u] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.chidi!}`
    chidiToken = as(u!.user_id, 'chidi@example.com')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('connects with OAuth and keeps tokens encrypted (F1.07)', async () => {
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ available: true, connected: false })
    const { url } = (await post('/v1/zoom/connect', {})).body as { url: string }
    const state = new URL(url).searchParams.get('state')!
    // Zoom's redirect only hands the code to the settings page; nothing is saved yet.
    expect((await t.app.request(`/v1/zoom/callback?error=access_denied`)).headers.get('location')).toMatch(/zoom=cancelled$/)
    expect((await t.app.request(`/v1/zoom/callback?state=x`)).headers.get('location')).toMatch(/zoom=error$/)
    const back = await t.app.request(`/v1/zoom/callback?code=good-code&state=${encodeURIComponent(state)}`)
    expect(back.status).toBe(302)
    const finish = new URL(back.headers.get('location')!)
    expect(finish.pathname + '?zoom=' + finish.searchParams.get('zoom')).toBe('/admin/settings/attendance?zoom=finish')
    expect(finish.searchParams.get('code')).toBe('good-code')
    expect(await sql`select 1 from zoom_connections`).toHaveLength(0)
    // Tampered state, or a refused code, never connects.
    expect((await post('/v1/zoom/complete', { code: 'good-code', state: `${state}x` })).body.error!.code).toBe('zoom_state_invalid')
    expect((await post('/v1/zoom/complete', { code: 'bad', state })).body.error!.code).toBe('zoom_connect_failed')
    // Someone else (another organisation's owner) can't finish an approval this admin started (CSRF).
    const other = { id: randomUUID(), email: 'owner@other.org' }
    await sql`insert into auth.users (id, email) values (${other.id}, ${other.email})`
    await req('POST', '/v1/organisations', { token: as(other.id, other.email), body: { organisationName: 'Other Org', fullName: 'Oth Er' } })
    expect((await req('POST', '/v1/zoom/complete', { token: as(other.id, other.email), body: { code: 'good-code', state } })).body.error!.code).toBe('zoom_state_invalid')
    // The admin who started it can.
    const ok = await post('/v1/zoom/complete', { code: 'good-code', state })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ connected: true, email: 'zoom@aliwa.org' })
    const [conn] = await sql<{ refresh_token_enc: string; zoom_user_email: string }[]>`select refresh_token_enc, zoom_user_email from zoom_connections`
    expect(conn!.refresh_token_enc).not.toContain('refresh-1')
    expect(box.open(conn!.refresh_token_enc)).toBe('refresh-1')
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ connected: true, email: 'zoom@aliwa.org', problem: null })
    // Without Zoom keys on the server, connecting says so.
    expect((await client(testApp(sql).app)('POST', '/v1/zoom/connect', { token, body: {} })).body.error!.code).toBe('zoom_not_configured')
  })

  it('creates a meeting for each online session and registers participants for personal links (C1.02)', async () => {
    const res = await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(2), start: '10:00', end: '12:00', mode: 'online' })
    ids.session = (res.body as { firstSessionId: string }).firstSessionId
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(3), start: '10:00', end: '12:00', mode: 'online', joinUrl: 'https://meet.example/x' })
    expect(((await get(`/v1/sessions/${ids.session}`)).body.session as { zoom: unknown }).zoom).toMatchObject({ pending: true, managed: false })
    const counts = await sync()
    expect(counts).toMatchObject({ created: 1, registered: 4 })
    expect(zoom.meetings.get('1')).toMatchObject({ topic: 'Python for Data Analysis · Cohort 5', durationMinutes: 120, registration: true, timeZone: 'Africa/Lagos' })
    const detail = (await get(`/v1/sessions/${ids.session}`)).body.session as { joinUrl: string; zoom: unknown }
    expect(detail).toMatchObject({ joinUrl: 'https://zoom.us/j/1', zoom: { managed: true, pending: false } })
    // Chidi joins with his own link; a session with a pasted link is left alone.
    const mine = await sql`update sessions set starts_at = now() - interval '5 minutes', ends_at = now() + interval '2 hours' where id = ${ids.session!} returning id`
    expect(mine).toHaveLength(1)
    expect(((await get(`/v1/my/sessions/${ids.session}`, chidiToken)).body.session as { joinUrl: string }).joinUrl).toBe('https://zoom.us/w/1?tk=chidi@example.com')
    await sql`update sessions set starts_at = ${at(48)}, ends_at = ${at(50)} where id = ${ids.session!}`
    expect(zoom.calls.filter((c) => c.startsWith('create'))).toEqual(['create 1'])
    expect((await sync()).registered).toBe(0)
  })

  it('moves the meeting when the time changes and removes it when cancelled or replaced', async () => {
    await req('PATCH', `/v1/sessions/${ids.session}`, { token, body: { date: day(2), start: '11:00', end: '12:30', mode: 'online', joinUrl: 'https://zoom.us/j/1' } })
    expect((await sync()).updated).toBe(1)
    expect(zoom.meetings.get('1')!.durationMinutes).toBe(90)
    // Pasting another link replaces Synqop's meeting.
    await req('PATCH', `/v1/sessions/${ids.session}`, { token, body: { date: day(2), start: '11:00', end: '12:30', mode: 'online', joinUrl: 'https://meet.example/own' } })
    expect((await sync()).deleted).toBe(1)
    expect(await sql`select zoom_join_url, zoom_managed from sessions where id = ${ids.session!}`).toEqual([{ zoom_join_url: 'https://meet.example/own', zoom_managed: false }])
    expect(await sql`select 1 from session_join_links where session_id = ${ids.session!}`).toHaveLength(0)
    // A new session gets a meeting; cancelling removes it.
    const s2 = ((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(4), start: '10:00', end: '12:00', mode: 'online' })).body as { firstSessionId: string }).firstSessionId
    await sync()
    await post(`/v1/sessions/${s2}/cancel`, { reason: 'Holiday', notify: false })
    expect((await sync()).deleted).toBe(1)
    expect(zoom.calls.at(-1)).toBe('delete 2')
  })

  it('makes the meeting within moments of saving, not at the next scheduler run', async () => {
    const soonApp = client(testApp(sql, { zoom: zoom.api, zoomBox: box, zoomSoon: zoomSoon(deps, 0) }).app)
    const before = zoom.calls.filter((c) => c.startsWith('create')).length
    const res = await soonApp('POST', '/v1/sessions', { token, body: { cohortId: ids.cohort, courseId: ids.course, date: day(5), start: '10:00', end: '12:00', mode: 'online' } })
    const id = (res.body as { firstSessionId: string }).firstSessionId
    let row: { zoom_managed: boolean } | undefined
    for (let i = 0; i < 50 && !row?.zoom_managed; i++) {
      await new Promise((r) => setTimeout(r, 20))
      ;[row] = await sql<{ zoom_managed: boolean }[]>`select zoom_managed from sessions where id = ${id}`
    }
    expect(row?.zoom_managed).toBe(true)
    // A scheduler run at the same moment waits its turn instead of making a second meeting.
    await Promise.all([syncZoomQueued(deps, ids.org!), syncZoomQueued(deps, ids.org!)])
    expect(zoom.calls.filter((c) => c.startsWith('create')).length).toBe(before + 1)
    await soonApp('POST', `/v1/sessions/${id}/cancel`, { token, body: { reason: 'Test', notify: false } })
    for (let i = 0; i < 50 && zoom.meetings.has(String(before + 1)) && !zoom.calls.includes(`delete ${before + 1}`); i++) await new Promise((r) => setTimeout(r, 20))
    expect(zoom.calls).toContain(`delete ${before + 1}`)
  })

  it('refreshes tokens, and marks the connection broken when Zoom stops accepting it', async () => {
    await sql`update zoom_connections set access_token_expires_at = now() - interval '1 minute'`
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(5), start: '10:00', end: '12:00', mode: 'online' })
    await sync()
    expect(zoom.refreshes).toBe(1)
    const [conn] = await sql<{ refresh_token_enc: string }[]>`select refresh_token_enc from zoom_connections`
    expect(box.open(conn!.refresh_token_enc)).toBe('refresh-1-r1')

    zoom.fail(new ZoomError(401, 'invalid_token', 'Invalid access token'))
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(6), start: '10:00', end: '12:00', mode: 'online' })
    await sync()
    zoom.fail(null)
    const settings = (await get('/v1/settings/attendance')).body.settings as { zoom: { problem: string } }
    expect(settings.zoom.problem).toMatch(/Connect Zoom again/)
    // While broken nothing is sent; connecting again clears it.
    expect((await sync()).created).toBe(0)
    await sql`update zoom_connections set broken_at = null, broken_reason = null`
  })

  it('imports attendance after the meeting, keeping hand-made marks (C2.01)', async () => {
    const id = ((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(1), start: '10:00', end: '12:00', mode: 'online' })).body as { firstSessionId: string })
      .firstSessionId
    await sync()
    const [m] = await sql<{ zoom_meeting_id: string }[]>`select zoom_meeting_id from sessions where id = ${id}`
    // The session happened: 10:00–12:00, ended 30 minutes ago.
    const start = at(-2.5)
    const end = at(-0.5)
    await sql`update sessions set starts_at = ${start}, ends_at = ${end} where id = ${id}`
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source) values (${ids.org!}, ${id}, ${ids.amara!}, 'excused', 'manual')`
    const mins = (x: number) => new Date(start.getTime() + x * 60_000)
    // Not ready yet: tried again next run.
    zoom.reports.set(m!.zoom_meeting_id, null)
    expect((await sync()).imported).toBe(0)
    zoom.reports.set(m!.zoom_meeting_id, [
      { name: 'Chidi N', email: 'CHIDI@example.com', joinTime: mins(15), leaveTime: mins(60), durationSeconds: 45 * 60 },
      { name: 'Chidi N', email: 'chidi@example.com', joinTime: mins(65), leaveTime: mins(120), durationSeconds: 55 * 60 },
      { name: 'Amara', email: 'amara@example.com', joinTime: mins(0), leaveTime: mins(30), durationSeconds: 30 * 60 },
      { name: 'Ngozi Eze', email: 'ngozi@aliwa.org', joinTime: mins(0), leaveTime: mins(120), durationSeconds: 120 * 60 },
      { name: 'Tobi A', email: 'tobi.a.dev@gmail.com', joinTime: mins(2), leaveTime: mins(114), durationSeconds: 112 * 60 },
      { name: 'Guest 4721', email: null, joinTime: mins(30), leaveTime: mins(71), durationSeconds: 41 * 60 },
    ])
    expect((await sync()).imported).toBe(1)
    const register = (await get(`/v1/sessions/${id}/attendance`)).body as { zoom: unknown; register: { name: string; status: string; source: string; minutesInMeeting: number | null; late: boolean }[] }
    expect(register.zoom).toMatchObject({ meeting: true, unmatched: 2 })
    expect(register.register.map((r) => [r.name, r.status, r.source, r.minutesInMeeting, r.late])).toEqual([
      ['Amara Okafor', 'excused', 'manual', null, false],
      ['Bisi Ade', 'absent', 'zoom', null, false],
      ['Chidi Nwosu', 'present', 'zoom', 100, true],
      ['Tobi Adewale', 'absent', 'zoom', null, false],
    ])
    // Admins and the trainer hear there are names to match.
    expect(await sql`select title, link_path from notifications where event = 'zoom_review' order by link_path`).toEqual([
      { title: '2 Zoom attendees to review', link_path: `/admin/courses/sessions/${id}/attendance/zoom` },
      { title: '2 Zoom attendees to review', link_path: `/trainer/sessions/${id}/attendance/zoom` },
    ])
    expect((await sync()).imported).toBe(0)
    ids.held = id
  })

  it('matches or ignores the names Zoom couldn’t link (C2.04)', async () => {
    const view = (await get(`/v1/sessions/${ids.held}/attendance/zoom`)).body as { attendees: { id: string; name: string; minutes: number; suggestedMemberId: string | null }[] }
    expect(view.attendees.map((a) => [a.name, a.minutes, a.suggestedMemberId])).toEqual([
      ['Guest 4721', 41, null],
      ['Tobi A', 112, ids.tobi],
    ])
    const [guest, tobi] = view.attendees
    expect((await post(`/v1/sessions/${ids.held}/attendance/zoom`, { matches: [{ id: tobi!.id, memberId: randomUUID() }] })).status).toBe(400)
    const saved = await post(`/v1/sessions/${ids.held}/attendance/zoom`, { matches: [{ id: tobi!.id, memberId: ids.tobi }], ignore: [guest!.id] })
    expect(saved.body).toEqual({ matched: 1, ignored: 1, kept: 0 })
    const register = (await get(`/v1/sessions/${ids.held}/attendance`)).body as { zoom: { unmatched: number }; register: { name: string; status: string; minutesInMeeting: number | null }[] }
    expect(register.zoom.unmatched).toBe(0)
    expect(register.register.find((r) => r.name === 'Tobi Adewale')).toMatchObject({ status: 'present', minutesInMeeting: 112 })
  })

  it('hosts classes at the same time on different Zoom users, starts them, links recordings and warns about clashes (pilot feedback, Nov 2026)', async () => {
    await sql`update zoom_connections set scopes = scopes || ${['user:read:list_users:admin', 'meeting:read:meeting:admin', 'cloud_recording:read:list_recording_files:admin']}::text[], users_checked_at = null`
    zoom.users.push({ id: 'u-main', email: 'zoom@aliwa.org', type: 2 }, { id: 'u-ngozi', email: 'ngozi@aliwa.org', type: 2 }, { id: 'u-room', email: 'room1@aliwa.org', type: 2 })
    // Three classes at 14:00 on the same day: Ngozi's own Zoom user, then the connected account, then the room.
    const at14 = async () => ((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(9), start: '14:00', durationMinutes: 60, mode: 'online' })).body as { firstSessionId: string }).firstSessionId
    const a = await at14()
    const b = await at14()
    await sql`update sessions set trainer_member_id = null where id = ${b}`
    const c = await at14()
    await sql`update sessions set trainer_member_id = null where id = ${c}`
    await sync()
    expect(zoom.calls).toContain('users')
    const hosts = await sql<{ id: string; zoom_host_id: string | null }[]>`select id, zoom_host_id from sessions where id in ${sql([a, b, c])}`
    const hostOf = (id: string) => hosts.find((h) => h.id === id)!.zoom_host_id
    expect(hostOf(a)).toBe('u-ngozi')
    expect(new Set([hostOf(b), hostOf(c)])).toEqual(new Set([null, 'u-room']))
    const created = [...zoom.meetings.values()].at(-1)!
    expect(created.record).toBe(true)

    // A fourth at the same time: every host is busy, so the form warns.
    const clash = await post('/v1/sessions/clashes', { date: day(9), start: '14:30', durationMinutes: 60, mode: 'online', trainerMemberId: ids.trainer })
    expect(clash.body.zoom).toEqual([expect.objectContaining({ hosts: 3, sessions: expect.any(Array) })])
    expect((clash.body.trainer as unknown[]).length).toBe(3)
    const fine = await post('/v1/sessions/clashes', { date: day(9), start: '16:00', durationMinutes: 60, mode: 'online', trainerMemberId: ids.trainer })
    expect(fine.body).toEqual({ trainer: [], zoom: [] })
    // A pasted link never needs a Zoom host.
    expect((await post('/v1/sessions/clashes', { date: day(9), start: '14:30', durationMinutes: 60, mode: 'online', joinUrl: 'https://meet.example/x' })).body.zoom).toEqual([])

    // Start class: a fresh host link for staff, never for participants.
    expect((await post(`/v1/sessions/${a}/zoom/start`, {})).body).toEqual({ url: expect.stringContaining('zak=') })
    expect((await req('POST', `/v1/sessions/${a}/zoom/start`, { token: chidiToken, body: {} })).status).toBe(403)

    // After class, Zoom's recording is linked for the cohort.
    const [meeting] = await sql<{ zoom_meeting_id: string }[]>`select zoom_meeting_id from sessions where id = ${a}`
    await sql`update sessions set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = ${a}`
    zoom.reports.set(meeting!.zoom_meeting_id, [])
    expect((await sync()).recorded).toBe(0)
    zoom.recordings.set(meeting!.zoom_meeting_id, { shareUrl: 'https://zoom.us/rec/share/abc', passcode: 'x1y2', minutes: 58 })
    await sql`update sessions set recording_checked_at = null where id = ${a}`
    expect((await sync()).recorded).toBe(1)
    const mine = (await get(`/v1/my/sessions/${a}`, chidiToken)).body.session as { recording: unknown }
    expect(mine.recording).toEqual({ url: 'https://zoom.us/rec/share/abc', passcode: 'x1y2', minutes: 58 })
    expect(((await get(`/v1/sessions/${a}`)).body.session as { recording: unknown }).recording).toMatchObject({ minutes: 58 })
  })

  it('disconnects', async () => {
    expect((await req('DELETE', '/v1/zoom/connection', { token })).status).toBe(204)
    expect(zoom.calls.at(-1)).toBe('revoke')
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ connected: false })
  })
})
