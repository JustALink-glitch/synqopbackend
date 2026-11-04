import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** What the activity log can be narrowed to, by the start of the action name. */
export const ACTIVITY_GROUPS = {
  sessions: ['session.', 'sessions.', 'session_report.', 'attendance.'],
  people: ['member.', 'participant.', 'participants.', 'enrolment.', 'certificates.', 'outcome.'],
  programmes: ['programme.', 'cohort.', 'course.'],
  work: ['assignment.', 'submission.', 'grade.'],
  flags: ['attention.', 'intervention.'],
  resources: ['resource.'],
  announcements: ['announcement.'],
  reports: ['report.', 'data.'],
  settings: ['settings.', 'organisation.', 'zoom.'],
} as const

const WHO = {
  staff: ['owner', 'admin', 'trainer', 'assistant_trainer'],
  admins: ['owner', 'admin'],
  trainers: ['trainer', 'assistant_trainer'],
  participants: ['participant'],
} as const

const PAGE = 50

type Row = {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  data: Record<string, unknown>
  created_at: Date
  actor_id: string | null
  actor_first: string | null
  actor_last: string | null
  actor_role: string | null
  name: string | null
  detail: string | null
}

/**
 * /v1/activity — Settings › Activity log (pilot feedback, Nov 2026): everything recorded in the organisation, newest
 * first. Reads the append-only audit trail through its (organisation, created_at) index, 50 at a time.
 */
export function activityRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>().use(requireAuth(deps), requireRole('owner', 'admin')).get('/', async (c) => {
    const { organisationId } = c.var.auth
    const whoKey = (c.req.query('who') ?? 'staff') as keyof typeof WHO
    const who = WHO[whoKey] ?? null
    const groupKey = c.req.query('group') as keyof typeof ACTIVITY_GROUPS | undefined
    const prefixes = groupKey && ACTIVITY_GROUPS[groupKey] ? [...ACTIVITY_GROUPS[groupKey]] : null
    const before = /^\d{1,18}$/.test(c.req.query('before') ?? '') ? c.req.query('before')! : null
    const sql = deps.sql
    const rows = await sql<Row[]>`
        select e.id::text, e.action, e.entity_type, e.entity_id, e.data, e.created_at,
               a.id as actor_id, a.first_name as actor_first, a.last_name as actor_last, a.role::text as actor_role,
               case e.entity_type
                 when 'session' then (select co.name from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
                                      join public.courses co on co.id = x.course_id where s.id = e.entity_id)
                 when 'cohort' then (select name from public.cohorts where id = e.entity_id)
                 when 'programme' then (select name from public.programmes where id = e.entity_id)
                 when 'course' then (select name from public.courses where id = e.entity_id)
                 when 'cohort_course' then (select co.name from public.cohort_courses x join public.courses co on co.id = x.course_id where x.id = e.entity_id)
                 when 'member' then (select trim(first_name || ' ' || last_name) from public.organisation_members where id = e.entity_id)
                 when 'enrolment' then (select trim(m.first_name || ' ' || m.last_name) from public.enrolments en
                                        join public.organisation_members m on m.id = en.member_id where en.id = e.entity_id)
                 when 'assignment' then (select title from public.assignments where id = e.entity_id)
                 when 'submission' then (select x.title from public.submissions s join public.assignments x on x.id = s.assignment_id where s.id = e.entity_id)
                 when 'announcement' then (select title from public.announcements where id = e.entity_id)
                 when 'report' then (select title from public.generated_reports where id = e.entity_id)
               end as name,
               case e.entity_type
                 when 'session' then (select h.name || ' · ' || to_char(s.starts_at at time zone o.time_zone, 'Dy FMDD Mon, HH24:MI')
                                      from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
                                      join public.cohorts h on h.id = x.cohort_id join public.organisations o on o.id = s.organisation_id
                                      where s.id = e.entity_id)
                 when 'cohort_course' then (select h.name from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id where x.id = e.entity_id)
                 when 'enrolment' then (select h.name from public.enrolments en join public.cohorts h on h.id = en.cohort_id where en.id = e.entity_id)
                 when 'submission' then (select trim(m.first_name || ' ' || m.last_name) from public.submissions s
                                         join public.organisation_members m on m.id = s.member_id where s.id = e.entity_id)
               end as detail
        from public.audit_events e
        left join public.organisation_members a on a.id = e.actor_member_id
        where e.organisation_id = ${organisationId}
          ${before ? sql`and e.id < ${before}::bigint` : sql``}
          ${who ? sql`and a.role::text in ${sql([...who])}` : sql``}
          ${prefixes ? sql`and (${prefixes.map((p, i) => (i ? sql`or e.action like ${p + '%'}` : sql`e.action like ${p + '%'}`)).reduce((x, y) => sql`${x} ${y}`)})` : sql``}
        order by e.id desc
        limit ${PAGE + 1}
      `
    const page = rows.slice(0, PAGE)
    return c.json({
      events: page.map((r) => ({
        id: r.id,
        action: r.action,
        at: r.created_at,
        actor: r.actor_id ? { id: r.actor_id, name: `${r.actor_first ?? ''} ${r.actor_last ?? ''}`.trim() || 'Someone', role: r.actor_role } : null,
        entity: { type: r.entity_type, id: r.entity_id, name: r.name, detail: r.detail },
        data: r.data,
      })),
      next: rows.length > PAGE ? page.at(-1)!.id : null,
    })
  })
}
