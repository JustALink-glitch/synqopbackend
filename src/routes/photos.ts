import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { parseBody } from '../lib/validation.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

const Ask = z.object({ ids: z.array(z.string().uuid()).max(300) })

/** How long a photo link works. The browser caches it, and asks again after this. */
const SECONDS = 3600

/**
 * POST /v1/photos — profile photos for people in lists (pilot feedback, Nov 2026: participant photos didn't show
 * on the admin side). One call for every avatar on a screen. Staff see anyone in their organisation; participants
 * see staff and themselves, never other participants.
 */
export function photoRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>().use(requireAuth(deps)).post('/', async (c) => {
    const { ids } = await parseBody(c, Ask)
    const auth = c.var.auth
    const unique = [...new Set(ids)]
    if (!unique.length) return c.json({ photos: {} })
    const participant = auth.role === 'participant'
    const rows = await deps.sql<{ id: string; path: string }[]>`
      select id, photo_path as path from public.organisation_members
      where organisation_id = ${auth.organisationId} and id in ${deps.sql(unique)} and photo_path is not null
        ${participant ? deps.sql`and (role <> 'participant' or id = ${auth.memberId})` : deps.sql``}
    `
    const paths = rows.map((r) => r.path)
    // Photos are a nicety: if storage can't sign them, everyone shows as initials.
    const urls: Record<string, string> = await (
      deps.storage.viewUrls
        ? deps.storage.viewUrls(paths, SECONDS)
        : Promise.all(paths.map(async (p) => [p, await deps.storage.viewUrl(p, SECONDS)] as const)).then(Object.fromEntries)
    ).catch(() => ({}))
    const photos: Record<string, string> = {}
    for (const r of rows) if (urls[r.path]) photos[r.id] = urls[r.path]!
    c.header('Cache-Control', 'private, max-age=600')
    return c.json({ photos })
  })
}
