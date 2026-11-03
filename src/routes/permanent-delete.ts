import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/**
 * Permanent delete for cohorts, programmes and library courses (pilot feedback, Nov 2026; owner's decision: only
 * while nothing has been recorded). "Recorded" means anything a report, a certificate or a participant's history
 * would rely on: attendance, submissions or grades, session reports, session feedback, follow-ups, outcomes,
 * completion reviews and certificates. Sessions, assignments, resources and enrolments set up but never used go
 * with it. Anything with records stays archive-only, so reports never lose their history.
 */

type Kind = 'cohort' | 'programme' | 'course'
type Check = {
  name: string
  deletable: boolean
  recorded: string[]
  removes: { cohorts: number; courses: number; sessions: number; assignments: number; participants: number }
}

/** Cohort courses in scope, as a SQL fragment. */
function scope(sql: Sql | Tx, kind: Kind, id: string) {
  if (kind === 'cohort') return sql`select id from public.cohort_courses where cohort_id = ${id}`
  if (kind === 'programme') return sql`select id from public.cohort_courses where programme_id = ${id}`
  return sql`select id from public.cohort_courses where course_id = ${id}`
}
/** Cohorts whose enrolments go too (only when the whole cohort is deleted). */
function cohortsOf(sql: Sql | Tx, kind: Kind, id: string) {
  if (kind === 'cohort') return sql`select ${id}::uuid as id`
  if (kind === 'programme') return sql`select id from public.cohorts where programme_id = ${id}`
  return sql`select null::uuid as id where false`
}

async function check(sql: Sql | Tx, kind: Kind, id: string, organisationId: string): Promise<Check> {
  const table = kind === 'cohort' ? sql`public.cohorts` : kind === 'programme' ? sql`public.programmes` : sql`public.courses`
  const [row] = await sql<{ name: string }[]>`select name from ${table} where id = ${id} and organisation_id = ${organisationId}`
  if (!row) throw notFound(`${kind === 'cohort' ? 'Cohort' : kind === 'programme' ? 'Programme' : 'Course'} not found.`)
  const ccs = scope(sql, kind, id)
  const cohorts = cohortsOf(sql, kind, id)
  const [r] = await sql<
    {
      attendance: boolean
      submissions: boolean
      reports: boolean
      feedback: boolean
      followups: boolean
      outcomes: boolean
      certificates: boolean
      cohorts: number
      courses: number
      sessions: number
      assignments: number
      participants: number
    }[]
  >`
    select
      exists (select 1 from public.attendance_records a join public.sessions s on s.id = a.session_id where s.cohort_course_id in (${ccs})) as attendance,
      exists (select 1 from public.submissions x join public.assignments a on a.id = x.assignment_id where a.cohort_course_id in (${ccs})) as submissions,
      exists (select 1 from public.session_reports x join public.sessions s on s.id = x.session_id where s.cohort_course_id in (${ccs})) as reports,
      exists (select 1 from public.session_feedback x join public.sessions s on s.id = x.session_id where s.cohort_course_id in (${ccs})) as feedback,
      exists (select 1 from public.interventions x join public.enrolments e on e.id = x.enrolment_id where e.cohort_id in (${cohorts})) as followups,
      (exists (select 1 from public.participant_outcomes x join public.enrolments e on e.id = x.enrolment_id where e.cohort_id in (${cohorts}))
        or exists (select 1 from public.completion_reviews x join public.enrolments e on e.id = x.enrolment_id where e.cohort_id in (${cohorts}))) as outcomes,
      exists (select 1 from public.certificates x join public.enrolments e on e.id = x.enrolment_id where e.cohort_id in (${cohorts})) as certificates,
      (select count(*)::int from (${cohorts}) c) as cohorts,
      ${kind === 'programme' ? sql`(select count(*)::int from public.courses where programme_id = ${id})` : sql`(select count(distinct course_id)::int from public.cohort_courses where id in (${ccs}))`} as courses,
      (select count(*)::int from public.sessions where cohort_course_id in (${ccs})) as sessions,
      (select count(*)::int from public.assignments where cohort_course_id in (${ccs})) as assignments,
      (select count(distinct member_id)::int from public.enrolments where cohort_id in (${cohorts})) as participants
  `
  const recorded = [
    r!.attendance && 'attendance',
    r!.submissions && 'submitted work',
    r!.reports && 'session reports',
    r!.feedback && 'session feedback',
    r!.followups && 'follow-ups',
    r!.outcomes && 'outcomes or completion reviews',
    r!.certificates && 'certificates',
  ].filter((x): x is string => Boolean(x))
  return {
    name: row.name,
    deletable: recorded.length === 0,
    recorded,
    removes: { cohorts: r!.cohorts, courses: r!.courses, sessions: r!.sessions, assignments: r!.assignments, participants: r!.participants },
  }
}

export function permanentDeleteRoutes(deps: AppDeps) {
  const guard = [requireAuth(deps), requireRole('owner', 'admin')] as const

  const routes = (kind: Kind) => {
    const path = kind === 'cohort' ? '/cohorts' : kind === 'programme' ? '/programmes' : '/courses'
    return new Hono<{ Variables: AuthVariables }>()
      .get(`${path}/:id/delete-check`, ...guard, async (c) => {
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Not found.')
        return c.json(await check(deps.sql, kind, id, c.var.auth.organisationId))
      })
      .delete(`${path}/:id`, ...guard, async (c) => {
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Not found.')
        const auth = c.var.auth
        const paths = await deps.sql.begin(async (tx) => {
          const result = await check(tx, kind, id, auth.organisationId)
          if (!result.deletable)
            throw new AppError(409, 'has_records', `This ${kind} has ${result.recorded.join(', ')}, so it can’t be deleted. Archive it instead.`, [
              { field: 'recorded', message: result.recorded.join(', ') },
            ])
          const ccs = scope(tx, kind, id)
          const files = await tx<{ path: string }[]>`
            select storage_path as path from public.resources where storage_path is not null and (cohort_course_id in (${ccs}) ${kind === 'course' ? tx`or course_id = ${id}` : tx``}
              ${kind === 'programme' ? tx`or course_id in (select id from public.courses where programme_id = ${id})` : tx``})
            union all
            select m.storage_path from public.assignment_materials m join public.assignments a on a.id = m.assignment_id
            where m.storage_path is not null and a.cohort_course_id in (${ccs})
          `
          if (kind === 'course') {
            await tx`delete from public.cohort_courses where course_id = ${id}`
            await tx`delete from public.courses where id = ${id}`
          } else {
            const cohorts = kind === 'cohort' ? [id] : (await tx<{ id: string }[]>`select id from public.cohorts where programme_id = ${id}`).map((r) => r.id)
            if (cohorts.length) {
              await tx`update public.enrolments set transferred_from_id = null where transferred_from_id in (select id from public.enrolments where cohort_id in ${tx(cohorts)})`
              await tx`delete from public.enrolments where cohort_id in ${tx(cohorts)}`
              await tx`delete from public.cohorts where id in ${tx(cohorts)}`
            }
            if (kind === 'programme') {
              await tx`delete from public.cohort_courses where programme_id = ${id}`
              await tx`delete from public.courses where programme_id = ${id}`
              await tx`delete from public.programmes where id = ${id}`
            }
          }
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: `${kind}.deleted`,
            entityType: kind,
            entityId: id,
            data: { name: result.name, ...result.removes },
            requestId: c.var.requestId,
          })
          return files.map((f) => f.path)
        })
        if (paths.length) await deps.storage.remove(paths).catch((e) => console.error('Removing files after a delete failed', e))
        return c.body(null, 204)
      })
  }

  return new Hono<{ Variables: AuthVariables }>().route('/', routes('cohort')).route('/', routes('programme')).route('/', routes('course'))
}
