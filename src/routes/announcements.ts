import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { deliver } from '../lib/notifications.js'
import type { Role } from '../lib/roles.js'
import { isAdmin } from '../lib/staff.js'
import { parseBody, uuid } from '../lib/validation.js'
import type { AuthContext } from '../lib/auth.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

type Audience = 'everyone' | 'staff' | 'participants' | 'cohort'

const Write = z
  .object({
    title: z.string().trim().min(1, 'Add a title.').max(120, 'Keep the title to 120 characters or fewer.'),
    body: z.string().trim().min(1, 'Write your announcement.').max(4000, 'Keep it to 4,000 characters or fewer.'),
    audience: z.enum(['everyone', 'staff', 'participants', 'cohort']),
    cohortId: uuid.nullish().transform((v) => v ?? null),
    important: z.boolean().default(false),
  })
  .refine((v) => v.audience !== 'cohort' || v.cohortId, { path: ['cohortId'], message: 'Choose a cohort.' })

const Edit = z.object({
  title: z.string().trim().min(1, 'Add a title.').max(120, 'Keep the title to 120 characters or fewer.'),
  body: z.string().trim().min(1, 'Write your announcement.').max(4000, 'Keep it to 4,000 characters or fewer.'),
})

interface Row {
  id: string
  audience: Audience
  cohort_id: string | null
  cohort_name: string | null
  title: string
  body: string
  important: boolean
  created_at: Date
  updated_at: Date
  author_id: string | null
  author_first: string | null
  author_last: string | null
  author_role: Role | null
}

const STAFF: Role[] = ['owner', 'admin', 'trainer', 'assistant_trainer']
const isStaff = (role: Role) => STAFF.includes(role)

/** Cohorts this trainer teaches (any course in them). */
const taughtCohorts = async (sql: Sql, memberId: string) =>
  (
    await sql<{ id: string }[]>`
      select distinct x.cohort_id as id from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id where t.member_id = ${memberId}
    `
  ).map((r) => r.id)

/** /v1/announcements — G1.03: news from admins and trainers, kept on one page and sent to the bell (and push). */
export function announcementRoutes(deps: AppDeps) {
  /** What this person may read: admins everything; others what's addressed to them. */
  async function visible(auth: AuthContext, id?: string) {
    const admin = isAdmin(auth)
    const staff = isStaff(auth.role)
    const cohorts = admin
      ? []
      : staff
        ? await taughtCohorts(deps.sql, auth.memberId)
        : (
            await deps.sql<
              { id: string }[]
            >`select cohort_id as id from public.enrolments where member_id = ${auth.memberId} and status in ('active', 'deferred', 'completed')`
          ).map((r) => r.id)
    return deps.sql<Row[]>`
      select a.id, a.audience, a.cohort_id, h.name as cohort_name, a.title, a.body, a.important, a.created_at, a.updated_at,
             m.id as author_id, m.first_name as author_first, m.last_name as author_last, m.role as author_role
      from public.announcements a
      left join public.cohorts h on h.id = a.cohort_id
      left join public.organisation_members m on m.id = a.author_member_id
      where a.organisation_id = ${auth.organisationId} and a.deleted_at is null
        ${id ? deps.sql`and a.id = ${id}` : deps.sql``}
        ${
          admin
            ? deps.sql``
            : deps.sql`and (a.audience = 'everyone' or a.audience = ${staff ? 'staff' : 'participants'}
                 or (a.audience = 'cohort' and a.cohort_id = any(${cohorts}::uuid[])) or a.author_member_id = ${auth.memberId})`
        }
      order by a.created_at desc
      limit 200
    `
  }

  const toJson = (r: Row, auth: AuthContext) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    important: r.important,
    audience: r.audience,
    cohort: r.cohort_id ? { id: r.cohort_id, name: r.cohort_name } : null,
    author: r.author_id ? { id: r.author_id, name: `${r.author_first} ${r.author_last ?? ''}`.trim(), role: r.author_role } : null,
    createdAt: r.created_at,
    edited: r.updated_at.getTime() - r.created_at.getTime() > 60_000,
    can: { edit: r.author_id === auth.memberId || isAdmin(auth) },
  })

  /** Where each role reads announcements; the bell links there. */
  const page = (role: Role) =>
    role === 'participant' ? '/participant/announcements' : role === 'owner' || role === 'admin' ? '/admin/announcements' : '/trainer/announcements'

  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))

    .get('/', async (c) => {
      const auth = c.var.auth
      const rows = await visible(auth)
      const admin = isAdmin(auth)
      const staff = isStaff(auth.role)
      // Where this person can post: admins anywhere; trainers to cohorts they teach; participants nowhere.
      const cohorts = admin
        ? await deps.sql<{ id: string; name: string }[]>`
            select id, name from public.cohorts where organisation_id = ${auth.organisationId} and archived_at is null order by starts_on desc nulls last, name
          `
        : staff
          ? await deps.sql<{ id: string; name: string }[]>`
              select id, name from public.cohorts where id = any(${await taughtCohorts(deps.sql, auth.memberId)}::uuid[]) and archived_at is null order by starts_on desc nulls last, name
            `
          : []
      return c.json({
        announcements: rows.map((r) => toJson(r, auth)),
        canPost: admin || (staff && cohorts.length > 0),
        audiences: admin ? ['everyone', 'staff', 'participants', 'cohort'] : staff && cohorts.length ? ['cohort'] : [],
        cohorts,
      })
    })

    .post('/', async (c) => {
      const auth = c.var.auth
      const body = await parseBody(c, Write)
      const admin = isAdmin(auth)
      if (!admin && !isStaff(auth.role)) throw forbidden('Only admins and trainers can post announcements.')
      if (!admin && body.audience !== 'cohort') throw forbidden('Trainers post to the cohorts they teach.')
      if (body.audience === 'cohort') {
        const [cohort] =
          await deps.sql`select 1 from public.cohorts where id = ${body.cohortId} and organisation_id = ${auth.organisationId} and archived_at is null`
        const mine = admin || (await taughtCohorts(deps.sql, auth.memberId)).includes(body.cohortId!)
        if (!cohort || !mine)
          throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'cohortId', message: 'Choose one of your cohorts.' }])
      }
      const cohortId = body.audience === 'cohort' ? body.cohortId : null
      const [row] = await deps.sql<{ id: string }[]>`
        insert into public.announcements (organisation_id, author_member_id, audience, cohort_id, title, body, important)
        values (${auth.organisationId}, ${auth.memberId}, ${body.audience}, ${cohortId}, ${body.title}, ${body.body}, ${body.important})
        returning id
      `
      await audit(deps.sql, {
        organisationId: auth.organisationId,
        actorMemberId: auth.memberId,
        action: 'announcement.posted',
        entityType: 'announcement',
        entityId: row!.id,
        data: { audience: body.audience, cohortId, important: body.important },
        requestId: c.var.requestId,
      })

      // Who it reaches: everyone active in the audience, but not the author.
      const people = await deps.sql<{ id: string; role: Role }[]>`
        select m.id, m.role from public.organisation_members m
        where m.organisation_id = ${auth.organisationId} and m.status = 'active' and m.id <> ${auth.memberId}
          and ${
            body.audience === 'everyone'
              ? deps.sql`true`
              : body.audience === 'staff'
                ? deps.sql`m.role <> 'participant'`
                : body.audience === 'participants'
                  ? deps.sql`m.role = 'participant'`
                  : deps.sql`(m.role in ('owner', 'admin')
                      or exists (select 1 from public.enrolments e where e.member_id = m.id and e.cohort_id = ${cohortId} and e.status = 'active')
                      or exists (select 1 from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
                                 where t.member_id = m.id and x.cohort_id = ${cohortId}))`
          }
      `
      const [me] = await deps.sql<{ name: string; org: string }[]>`
        select trim(m.first_name || ' ' || coalesce(m.last_name, '')) as name, o.name as org
        from public.organisation_members m join public.organisations o on o.id = m.organisation_id where m.id = ${auth.memberId}
      `
      const preview = body.body.length > 140 ? `${body.body.slice(0, 137).trimEnd()}…` : body.body
      let emailed = 0
      // Each role has its own page; send once per page so the link is right.
      for (const role of new Set(people.map((p) => page(p.role)))) {
        const ids = people.filter((p) => page(p.role) === role).map((p) => p.id)
        emailed += await deliver(deps, {
          organisationId: auth.organisationId,
          to: { memberIds: ids },
          event: 'announcement',
          title: `${me!.name}: ${body.title}`,
          body: preview,
          link: `${role}#${row!.id}`,
          // Email only when the author marks it important (X2: email is for the things that matter most).
          ...(body.important && {
            email: {
              subject: `${body.title} — ${me!.org}`,
              title: body.title,
              intro: (first: string) => `Hi ${first}, ${me!.name} posted an announcement:\n\n${body.body}`,
              buttonLabel: 'Open announcements',
              footer: 'You get this because it was marked important. Change announcement emails in Settings › Notifications.',
            },
          }),
        })
      }
      const [created] = await visible(auth, row!.id)
      return c.json({ announcement: toJson(created!, auth), reached: people.length, emailed }, 201)
    })

    .patch('/:id', async (c) => {
      const auth = c.var.auth
      const id = c.req.param('id')
      if (!uuid.safeParse(id).success) throw notFound('Announcement not found.')
      const body = await parseBody(c, Edit)
      const [row] = await visible(auth, id)
      if (!row) throw notFound('Announcement not found.')
      if (row.author_id !== auth.memberId && !isAdmin(auth)) throw forbidden('Only the author or an admin can change this announcement.')
      // Edits don't notify again.
      await deps.sql`update public.announcements set title = ${body.title}, body = ${body.body}, updated_at = now() where id = ${id}`
      await audit(deps.sql, {
        organisationId: auth.organisationId,
        actorMemberId: auth.memberId,
        action: 'announcement.edited',
        entityType: 'announcement',
        entityId: id,
        requestId: c.var.requestId,
      })
      const [updated] = await visible(auth, id)
      return c.json({ announcement: toJson(updated!, auth) })
    })

    .delete('/:id', async (c) => {
      const auth = c.var.auth
      const id = c.req.param('id')
      if (!uuid.safeParse(id).success) throw notFound('Announcement not found.')
      const [row] = await visible(auth, id)
      if (!row) throw notFound('Announcement not found.')
      if (row.author_id !== auth.memberId && !isAdmin(auth)) throw forbidden('Only the author or an admin can delete this announcement.')
      await deps.sql`update public.announcements set deleted_at = now() where id = ${id}`
      // Take it out of people's bells too.
      await deps.sql`delete from public.notifications where organisation_id = ${auth.organisationId} and event = 'announcement' and link_path like ${'%#' + id}`
      await audit(deps.sql, {
        organisationId: auth.organisationId,
        actorMemberId: auth.memberId,
        action: 'announcement.deleted',
        entityType: 'announcement',
        entityId: id,
        requestId: c.var.requestId,
      })
      return c.body(null, 204)
    })
}
