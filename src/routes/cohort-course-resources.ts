import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import { audit } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { notify } from '../lib/notifications.js'
import { can, staffScope } from '../lib/staff.js'
import { MAX_FILE_BYTES, safeFileName } from '../lib/storage.js'
import { parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { Resource, toResource, Upload, type ResourceRow } from './session-resources.js'

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

/**
 * /v1/cohort-courses/:id/resources — resources for a whole course in one cohort, without opening a session first
 * (pilot feedback, Nov 2026: trainers wanted to add course resources). Lead trainers of the course, assistants when
 * Programme setup allows, and admins. Library-wide course resources (added by admins) are listed but read-only here.
 */
export function cohortCourseResourceRoutes(deps: AppDeps) {
  const prefix = (organisationId: string) => `${organisationId}/resources/`

  async function find(auth: AuthContext, rawId: string, write: boolean) {
    if (!uuid.safeParse(rawId).success) throw notFound('Course not found.')
    const [row] = await deps.sql<{ id: string; course_id: string; course: string; cohort_id: string }[]>`
      select x.id, x.course_id, co.name as course, x.cohort_id from public.cohort_courses x join public.courses co on co.id = x.course_id
      where x.id = ${rawId} and x.organisation_id = ${auth.organisationId}
    `
    if (!row) throw notFound('Course not found.')
    const allowed = can(await staffScope(deps.sql, auth), row.id)
    if (!allowed.see) throw notFound('Course not found.')
    if (write && !allowed.resources) throw forbidden('Your organisation doesn’t let assistant trainers add resources.')
    return { ...row, canAdd: allowed.resources }
  }

  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin', 'trainer', 'assistant_trainer'))
    .get('/:id/resources', async (c) => {
      const cc = await find(c.var.auth, c.req.param('id'), false)
      const rows = await deps.sql<(ResourceRow & { library: boolean })[]>`
        select r.id, r.kind, r.name, r.url, r.size_bytes, r.mime_type, r.session_id, r.visible_to_participants, r.added_by,
               m.first_name as by_first, m.last_name as by_last, r.created_at, r.course_id is not null as library
        from public.resources r left join public.organisation_members m on m.id = r.added_by
        where (r.cohort_course_id = ${cc.id} and r.session_id is null) or r.course_id = ${cc.course_id}
        order by r.created_at desc
      `
      return c.json({
        course: cc.course,
        canAdd: cc.canAdd,
        resources: rows.map((r) => ({
          ...toResource(r, c.var.auth.memberId),
          library: r.library,
          canRemove: !r.library && cc.canAdd && (c.var.auth.role !== 'assistant_trainer' || r.added_by === c.var.auth.memberId),
        })),
      })
    })
    .post('/:id/resources/uploads', async (c) => {
      const body = await parseBody(c, Upload)
      await find(c.var.auth, c.req.param('id'), true)
      const path = `${prefix(c.var.auth.organisationId)}${randomUUID()}/${safeFileName(body.name)}`
      return c.json({ upload: await deps.storage.createUpload(path) })
    })
    .post('/:id/resources', async (c) => {
      const body = await parseBody(c, Resource)
      const auth = c.var.auth
      const cc = await find(auth, c.req.param('id'), true)
      let size: number | null = null
      let type: string | null = null
      if (body.kind === 'file') {
        if (!body.path!.startsWith(prefix(auth.organisationId)) || body.path!.includes('..')) throw fieldError('path', 'Choose the file again.')
        const stat = await deps.storage.stat(body.path!)
        if (!stat) throw fieldError('path', 'The file didn’t finish uploading. Choose it again.')
        if (stat.size > MAX_FILE_BYTES) throw fieldError('path', 'Files can be up to 25 MB.')
        size = stat.size
        type = stat.type
      }
      const id = await deps.sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into public.resources (organisation_id, cohort_course_id, session_id, kind, name, url, storage_path, size_bytes, mime_type, visible_to_participants, added_by)
          values (${auth.organisationId}, ${cc.id}, null, ${body.kind}, ${body.name}, ${body.kind === 'link' ? body.url : null}, ${body.kind === 'file' ? body.path! : null},
                  ${size}, ${type}, ${body.visible}, ${auth.memberId})
          returning id
        `
        await audit(tx, {
          organisationId: auth.organisationId,
          actorMemberId: auth.memberId,
          action: 'resource.added',
          entityType: 'cohort_course',
          entityId: cc.id,
          data: { kind: body.kind, scope: 'course' },
          requestId: c.var.requestId,
        })
        if (body.visible) {
          const people = await tx<{ id: string }[]>`select member_id as id from public.enrolments where cohort_id = ${cc.cohort_id} and status = 'active'`
          await notify(tx, {
            organisationId: auth.organisationId,
            to: { memberIds: people.map((p) => p.id) },
            event: 'new_resource',
            title: `New resource: ${body.name}`,
            body: cc.course,
            link: `/participant/courses/${cc.id}`,
          })
        }
        return row!.id
      })
      return c.json({ resource: { id } }, 201)
    })
    .get('/:id/resources/:resourceId', async (c) => {
      const cc = await find(c.var.auth, c.req.param('id'), false)
      const resourceId = c.req.param('resourceId')
      if (!uuid.safeParse(resourceId).success) throw notFound('Resource not found.')
      const [r] = await deps.sql<{ name: string; storage_path: string | null; url: string | null }[]>`
        select name, storage_path, url from public.resources where id = ${resourceId} and ((cohort_course_id = ${cc.id} and session_id is null) or course_id = ${cc.course_id})
      `
      if (!r) throw notFound('Resource not found.')
      return c.json({ url: r.storage_path ? await deps.storage.downloadUrl(r.storage_path, r.name) : r.url })
    })
    .delete('/:id/resources/:resourceId', async (c) => {
      const auth = c.var.auth
      const cc = await find(auth, c.req.param('id'), true)
      const resourceId = c.req.param('resourceId')
      if (!uuid.safeParse(resourceId).success) throw notFound('Resource not found.')
      const assistant = auth.role === 'assistant_trainer'
      const [gone] = await deps.sql<{ storage_path: string | null }[]>`
        delete from public.resources where id = ${resourceId} and cohort_course_id = ${cc.id} and session_id is null
          ${assistant ? deps.sql`and added_by = ${auth.memberId}` : deps.sql``}
        returning storage_path
      `
      if (!gone) throw notFound('Resource not found.')
      if (gone.storage_path) await deps.storage.remove([gone.storage_path]).catch(() => undefined)
      await audit(deps.sql, {
        organisationId: auth.organisationId,
        actorMemberId: auth.memberId,
        action: 'resource.removed',
        entityType: 'cohort_course',
        entityId: cc.id,
        data: { resourceId },
        requestId: c.var.requestId,
      })
      return c.body(null, 204)
    })
}
