import type { Sql } from './db.js'
import type { ReportParams } from './exports.js'

/* E1.06 Live view charts: the same definitions as the files, drawn on screen. Not part of the PDF or CSV. */

export interface Highlight {
  label: string
  value: string
  note?: string
  tone?: 'warn'
}

export type Chart =
  | {
      id: string
      title: string
      kind: 'stacked' | 'bars' | 'line'
      unit?: '%'
      labels: string[]
      series: { name: string; values: (number | null)[]; tone?: 'present' | 'excused' | 'absent' }[]
      note?: string
    }
  | { id: string; title: string; kind: 'barlist'; unit?: '%'; max?: number; rows: { label: string; value: number | null; note?: string }[]; note?: string }
  | { id: string; title: string; kind: 'donut'; centre: string; caption?: string; parts: { label: string; value: number }[]; note?: string }

export interface Insights {
  highlights: Highlight[]
  charts: Chart[]
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null)
const show = (v: number | null, unit = '%') => (v === null ? '—' : `${v}${unit}`)
const num = (v: string | number | null) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10)

export async function buildInsights(sql: Sql, organisationId: string, p: ReportParams): Promise<Insights> {
  const [org] = await sql<
    { tz: string; today: string }[]
  >`select time_zone as tz, (now() at time zone time_zone)::date::text as today from public.organisations where id = ${organisationId}`
  const tz = org!.tz
  const cohorts = await sql<{ id: string; name: string; starts_on: string; ends_on: string; status: string }[]>`
    select id, name, starts_on::text, ends_on::text, public.status(h) as status from public.cohorts h
    where programme_id = ${p.programmeId} and organisation_id = ${organisationId} ${p.cohortId ? sql`and id = ${p.cohortId}` : sql``}
    order by starts_on
  `
  const ids = cohorts.map((c) => c.id)
  if (!ids.length) return { highlights: [], charts: [] }
  const from = p.from ? sql`(${p.from}::date)::timestamp at time zone ${tz}` : sql`'-infinity'::timestamptz`
  const to = p.to ? sql`(${p.to}::date + 1)::timestamp at time zone ${tz}` : sql`'infinity'::timestamptz`
  // Trend range: the dates asked for, else the cohorts' own dates, never past today.
  const startDay = p.from ?? cohorts.map((c) => c.starts_on).sort()[0]!
  const endDay = [p.to ?? org!.today, org!.today].sort()[0]!
  const weekLabel = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))
  const dayLabel = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(d)

  /** Present, excused and absent per week in the range, for these cohorts. */
  const weekly = () =>
    startDay > endDay
      ? Promise.resolve([] as { week: string; present: number; excused: number; absent: number }[])
      : sql<{ week: string; present: number; excused: number; absent: number }[]>`
          with w as (select generate_series(date_trunc('week', ${startDay}::date), date_trunc('week', ${endDay}::date), interval '1 week')::date as week)
          select w.week::text,
                 count(a.id) filter (where a.status = 'present')::int as present,
                 count(a.id) filter (where a.status = 'excused')::int as excused,
                 count(a.id) filter (where a.status = 'absent')::int as absent
          from w
          left join public.sessions s on s.cancelled_at is null and date_trunc('week', s.starts_at at time zone ${tz})::date = w.week
            and s.cohort_course_id in (select id from public.cohort_courses where cohort_id = any(${ids}::uuid[]))
            and s.starts_at >= ${from} and s.starts_at < ${to}
          left join public.attendance_records a on a.session_id = s.id
          group by w.week order by w.week
        `

  const weeklyCharts = (rows: { week: string; present: number; excused: number; absent: number }[]): Chart[] =>
    rows.length < 2
      ? []
      : [
          {
            id: 'attendance-trend',
            title: 'Attendance by week',
            kind: 'line',
            unit: '%',
            labels: rows.map((r) => weekLabel(r.week)),
            series: [{ name: 'Attendance', values: rows.map((r) => pct(r.present, r.present + r.excused + r.absent)) }],
            note: 'Present ÷ recorded each week. Gaps are weeks with nothing recorded.',
          },
          {
            id: 'checkins',
            title: 'Check-ins by week',
            kind: 'stacked',
            labels: rows.map((r) => weekLabel(r.week)),
            series: [
              { name: 'Present', values: rows.map((r) => r.present), tone: 'present' },
              { name: 'Excused', values: rows.map((r) => r.excused), tone: 'excused' },
              { name: 'Absent', values: rows.map((r) => r.absent), tone: 'absent' },
            ],
          },
        ]

  if (p.kind === 'cohort_summary' || p.kind === 'programme_summary') {
    const per = await sql<
      {
        id: string
        active: number
        completed: number
        deferred: number
        withdrawn: number
        present: number
        recorded: number
        held: number
        submitted: number
        expected: number
        grade: string | null
        rating: string | null
        flagged: number
      }[]
    >`
      select h.id,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as active,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'completed') as completed,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'deferred') as deferred,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status in ('withdrawn', 'transferred')) as withdrawn,
             (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.cancelled_at is null and a.status = 'present' and s.starts_at >= ${from} and s.starts_at < ${to}) as present,
             (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.cancelled_at is null and s.starts_at >= ${from} and s.starts_at < ${to}) as recorded,
             (select count(*)::int from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and public.status(s) = 'held' and s.starts_at >= ${from} and s.starts_at < ${to}) as held,
             (select count(*)::int from public.submissions s join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
               where x.cohort_id = h.id and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to} and a.due_at <= now()) as submitted,
             (select count(*)::int * (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status in ('active', 'completed'))
               from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id
               where x.cohort_id = h.id and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to} and a.due_at <= now()) as expected,
             (select avg(g.score_pct) from public.grades g join public.submissions s on s.id = g.submission_id join public.assignments a on a.id = s.assignment_id
               join public.cohort_courses x on x.id = a.cohort_course_id where x.cohort_id = h.id and a.due_at >= ${from} and a.due_at < ${to}) as grade,
             (select avg(f.rating) from public.session_feedback f join public.sessions s on s.id = f.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.starts_at >= ${from} and s.starts_at < ${to}) as rating,
             (select count(distinct f.enrolment_id)::int from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
               where e.cohort_id = h.id and f.cleared_at is null and f.resolved_at is null) as flagged
      from public.cohorts h where h.id = any(${ids}::uuid[])
    `
    const sum = (k: 'active' | 'completed' | 'deferred' | 'withdrawn' | 'present' | 'recorded' | 'held' | 'submitted' | 'expected' | 'flagged') =>
      per.reduce((n, r) => n + r[k], 0)
    const grades = per.filter((r) => r.grade !== null)
    const ratings = per.filter((r) => r.rating !== null)
    const avgOf = (rows: (typeof per)[number][], k: 'grade' | 'rating') => (rows.length ? num(rows.reduce((n, r) => n + Number(r[k]), 0) / rows.length) : null)
    const highlights: Highlight[] = [
      { label: 'Active participants', value: String(sum('active')), note: `${sum('completed')} completed · ${sum('withdrawn')} withdrawn` },
      {
        label: 'Attendance',
        value: show(pct(sum('present'), sum('recorded'))),
        note: `${sum('present')} of ${sum('recorded')} check-ins · ${sum('held')} sessions held`,
      },
      {
        label: 'Work handed in',
        value: show(pct(sum('submitted'), sum('expected'))),
        note: sum('expected') ? `${sum('submitted')} of ${sum('expected')} due so far` : 'Nothing due yet',
      },
      { label: 'Average grade', value: show(avgOf(grades, 'grade')) },
      { label: 'Average rating', value: avgOf(ratings, 'rating') === null ? '—' : `${avgOf(ratings, 'rating')} / 5` },
      { label: 'Needs attention now', value: String(sum('flagged')), tone: sum('flagged') ? 'warn' : undefined },
    ]
    const charts: Chart[] = [
      {
        id: 'enrolment',
        title: 'Enrolment',
        kind: 'donut',
        centre: String(sum('active') + sum('completed') + sum('deferred') + sum('withdrawn')),
        caption: 'enrolled',
        parts: [
          { label: 'Active', value: sum('active') },
          { label: 'Completed', value: sum('completed') },
          { label: 'Deferred', value: sum('deferred') },
          { label: 'Withdrawn', value: sum('withdrawn') },
        ],
      },
      ...weeklyCharts(await weekly()),
    ]
    if (p.kind === 'cohort_summary') {
      const courses = await sql<{ name: string; present: number; recorded: number; held: number }[]>`
        select co.name,
               count(a.id) filter (where a.status = 'present')::int as present, count(a.id)::int as recorded,
               count(distinct s.id) filter (where public.status(s) = 'held')::int as held
        from public.cohort_courses x join public.courses co on co.id = x.course_id
        left join public.sessions s on s.cohort_course_id = x.id and s.cancelled_at is null and s.starts_at >= ${from} and s.starts_at < ${to}
        left join public.attendance_records a on a.session_id = s.id
        where x.cohort_id = ${ids[0]!} group by co.name order by co.name
      `
      charts.push({
        id: 'by-course',
        title: 'Attendance by course',
        kind: 'barlist',
        unit: '%',
        max: 100,
        rows: courses.map((c) => ({ label: c.name, value: pct(c.present, c.recorded), note: `${c.held} held` })),
      })
    } else {
      const name = new Map(cohorts.map((c) => [c.id, c.name]))
      charts.push(
        {
          id: 'cohort-attendance',
          title: 'Attendance by cohort',
          kind: 'barlist',
          unit: '%',
          max: 100,
          rows: per.map((r) => ({ label: name.get(r.id)!, value: pct(r.present, r.recorded) })),
        },
        {
          id: 'cohort-submitted',
          title: 'Work handed in by cohort',
          kind: 'barlist',
          unit: '%',
          max: 100,
          rows: per.map((r) => ({ label: name.get(r.id)!, value: pct(r.submitted, r.expected) })),
        },
        { id: 'cohort-active', title: 'Active participants by cohort', kind: 'barlist', rows: per.map((r) => ({ label: name.get(r.id)!, value: r.active })) },
      )
    }
    return { highlights, charts }
  }

  if (p.kind === 'attendance') {
    const rows = await sql<{ starts_at: Date; course: string; present: number; excused: number; absent: number; expected: number }[]>`
      select s.starts_at, co.name as course,
             count(a.id) filter (where a.status = 'present')::int as present,
             count(a.id) filter (where a.status = 'excused')::int as excused,
             count(a.id) filter (where a.status = 'absent')::int as absent,
             (select count(*)::int from public.enrolments e where e.cohort_id = x.cohort_id and e.status = 'active') as expected
      from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id
      left join public.attendance_records a on a.session_id = s.id
      where x.cohort_id = any(${ids}::uuid[]) and s.cancelled_at is null and s.ends_at <= now() and s.starts_at >= ${from} and s.starts_at < ${to}
      group by s.id, co.name, x.cohort_id order by s.starts_at
    `
    const present = rows.reduce((n, r) => n + r.present, 0)
    const recorded = rows.reduce((n, r) => n + r.present + r.excused + r.absent, 0)
    const missing = rows.filter((r) => r.present + r.excused + r.absent === 0).length
    const byCourse = new Map<string, { present: number; recorded: number }>()
    for (const r of rows) {
      const c = byCourse.get(r.course) ?? { present: 0, recorded: 0 }
      c.present += r.present
      c.recorded += r.present + r.excused + r.absent
      byCourse.set(r.course, c)
    }
    const recent = rows.slice(-30)
    return {
      highlights: [
        { label: 'Sessions held', value: String(rows.length) },
        { label: 'Attendance', value: show(pct(present, recorded)), note: `${present} of ${recorded} check-ins` },
        { label: 'Excused', value: String(rows.reduce((n, r) => n + r.excused, 0)) },
        { label: 'Absent', value: String(rows.reduce((n, r) => n + r.absent, 0)) },
        { label: 'Registers not taken', value: String(missing), tone: missing ? 'warn' : undefined },
      ],
      charts: [
        ...(recent.length
          ? [
              {
                id: 'per-session',
                title: rows.length > 30 ? 'Last 30 sessions' : 'By session',
                kind: 'stacked' as const,
                labels: recent.map((r) => dayLabel(r.starts_at)),
                series: [
                  { name: 'Present', values: recent.map((r) => r.present), tone: 'present' as const },
                  { name: 'Excused', values: recent.map((r) => r.excused), tone: 'excused' as const },
                  { name: 'Absent', values: recent.map((r) => r.absent), tone: 'absent' as const },
                ],
              },
            ]
          : []),
        ...weeklyCharts(await weekly()).filter((c) => c.id === 'attendance-trend'),
        {
          id: 'by-course',
          title: 'Attendance by course',
          kind: 'barlist',
          unit: '%',
          max: 100,
          rows: [...byCourse.entries()].map(([label, c]) => ({ label, value: pct(c.present, c.recorded) })),
        },
      ],
    }
  }

  if (p.kind === 'assignments') {
    const rows = await sql<{ title: string; expected: number; submitted: number; late: number; graded: number; grade: string | null; due_at: Date }[]>`
      select a.title, a.due_at,
             (select count(*)::int from public.enrolments e where e.cohort_id = x.cohort_id and e.status in ('active', 'completed')) as expected,
             (select count(*)::int from public.submissions s where s.assignment_id = a.id) as submitted,
             (select count(*)::int from public.submissions s where s.assignment_id = a.id and s.is_late) as late,
             (select count(*)::int from public.grades g join public.submissions s on s.id = g.submission_id where s.assignment_id = a.id) as graded,
             (select avg(g.score_pct) from public.grades g join public.submissions s on s.id = g.submission_id where s.assignment_id = a.id) as grade
      from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id
      where x.cohort_id = any(${ids}::uuid[]) and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to}
      order by a.due_at
    `
    const due = rows.filter((r) => r.due_at.getTime() <= Date.now())
    const submitted = due.reduce((n, r) => n + r.submitted, 0)
    const expected = due.reduce((n, r) => n + r.expected, 0)
    const all = rows.reduce((n, r) => n + r.submitted, 0)
    const graded = rows.reduce((n, r) => n + r.graded, 0)
    const withGrades = rows.filter((r) => r.grade !== null)
    return {
      highlights: [
        { label: 'Assignments', value: String(rows.length), note: `${due.length} past due` },
        { label: 'Work handed in', value: show(pct(submitted, expected)), note: expected ? `${submitted} of ${expected} due so far` : 'Nothing due yet' },
        { label: 'Handed in late', value: String(rows.reduce((n, r) => n + r.late, 0)) },
        { label: 'Graded', value: show(pct(graded, all)), note: `${graded} of ${all} submissions`, tone: all > graded ? 'warn' : undefined },
        { label: 'Average grade', value: show(withGrades.length ? Math.round(withGrades.reduce((n, r) => n + Number(r.grade), 0) / withGrades.length) : null) },
      ],
      charts: [
        {
          id: 'submitted',
          title: 'Handed in, by assignment',
          kind: 'barlist',
          unit: '%',
          max: 100,
          rows: rows.map((r) => ({ label: r.title, value: pct(r.submitted, r.expected), note: `${r.submitted} of ${r.expected}` })),
        },
        {
          id: 'grades',
          title: 'Average grade, by assignment',
          kind: 'barlist',
          unit: '%',
          max: 100,
          rows: rows.map((r) => ({ label: r.title, value: r.grade === null ? null : Math.round(Number(r.grade)) })),
        },
      ],
    }
  }

  // Feedback
  const rows = await sql<{ starts_at: Date; trainer: string | null; responses: number; rating: string | null }[]>`
    select s.starts_at, m.first_name || ' ' || m.last_name as trainer, count(f.id)::int as responses, avg(f.rating) as rating
    from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
    left join public.organisation_members m on m.id = s.trainer_member_id
    left join public.session_feedback f on f.session_id = s.id
    where x.cohort_id = any(${ids}::uuid[]) and s.cancelled_at is null and s.ends_at <= now() and s.starts_at >= ${from} and s.starts_at < ${to}
    group by s.id, m.first_name, m.last_name order by s.starts_at
  `
  const responses = rows.reduce((n, r) => n + r.responses, 0)
  const total = rows.reduce((n, r) => n + (r.rating === null ? 0 : Number(r.rating) * r.responses), 0)
  const trainers = new Map<string, { responses: number; total: number }>()
  for (const r of rows) {
    const t = trainers.get(r.trainer ?? 'No trainer') ?? { responses: 0, total: 0 }
    t.responses += r.responses
    t.total += r.rating === null ? 0 : Number(r.rating) * r.responses
    trainers.set(r.trainer ?? 'No trainer', t)
  }
  const recent = rows.slice(-30)
  return {
    highlights: [
      { label: 'Responses', value: String(responses), note: `${rows.length} sessions` },
      { label: 'Average rating', value: responses ? `${num(total / responses)} / 5` : '—' },
      { label: 'Sessions with feedback', value: show(pct(rows.filter((r) => r.responses > 0).length, rows.length)) },
    ],
    charts: [
      ...(recent.length > 1
        ? [
            {
              id: 'rating-trend',
              title: 'Rating by session',
              kind: 'line' as const,
              labels: recent.map((r) => dayLabel(r.starts_at)),
              series: [{ name: 'Rating', values: recent.map((r) => num(r.rating)) }],
              note: 'Average rating, 1 to 5.',
            },
          ]
        : []),
      ...(recent.length
        ? [
            {
              id: 'responses',
              title: 'Responses by session',
              kind: 'bars' as const,
              labels: recent.map((r) => dayLabel(r.starts_at)),
              series: [{ name: 'Responses', values: recent.map((r) => r.responses) }],
            },
          ]
        : []),
      {
        id: 'by-trainer',
        title: 'Rating by trainer',
        kind: 'barlist',
        max: 5,
        rows: [...trainers.entries()].map(([label, t]) => ({
          label,
          value: t.responses ? num(t.total / t.responses) : null,
          note: `${t.responses} responses`,
        })),
      },
    ],
  }
}
