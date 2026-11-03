import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { notFound } from '../lib/errors.js'
import { parseBody, uuid } from '../lib/validation.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

interface Row {
  id: string
  event: string
  title: string
  body: string | null
  link_path: string | null
  read_at: Date | null
  created_at: Date
}

const Subscription = z.object({
  endpoint: z.url().startsWith('https://').max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
})
const Unsubscribe = z.object({ endpoint: z.string().max(2000) })

/** /v1/notifications — G1.01 the bell: your own in-app notifications, newest first. */
export function notificationRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))

    .get('/', async (c) => {
      const { memberId } = c.var.auth
      const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
      const [rows, [count]] = await Promise.all([
        deps.sql<Row[]>`
          select id, event, title, body, link_path, read_at, created_at from public.notifications
          where recipient_member_id = ${memberId} order by created_at desc, id desc limit ${limit}
        `,
        deps.sql<{ n: number }[]>`select count(*)::int as n from public.notifications where recipient_member_id = ${memberId} and read_at is null`,
      ])
      return c.json({
        unread: count!.n,
        notifications: rows.map((r) => ({ id: r.id, event: r.event, title: r.title, body: r.body, link: r.link_path, readAt: r.read_at, createdAt: r.created_at })),
      })
    })

    // Web push: the key browsers need, and this device's subscription. Push follows the in-app choices.
    .get('/push/key', (c) => c.json({ publicKey: deps.push?.publicKey ?? null }))

    .put('/push/subscription', async (c) => {
      if (!deps.push) return c.json({ error: { code: 'push_unavailable', message: 'Push notifications aren’t set up yet.' } }, 409)
      const body = await parseBody(c, Subscription)
      const { memberId, organisationId } = c.var.auth
      // One device, one person: signing in as someone else on the same browser moves it to them.
      await deps.sql`
        insert into public.push_subscriptions (organisation_id, member_id, endpoint, p256dh, auth, user_agent)
        values (${organisationId}, ${memberId}, ${body.endpoint}, ${body.keys.p256dh}, ${body.keys.auth}, ${c.req.header('User-Agent')?.slice(0, 300) ?? null})
        on conflict (endpoint) do update set organisation_id = excluded.organisation_id, member_id = excluded.member_id,
          p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
      `
      return c.json({ ok: true })
    })

    .delete('/push/subscription', async (c) => {
      const body = await parseBody(c, Unsubscribe)
      await deps.sql`delete from public.push_subscriptions where endpoint = ${body.endpoint} and member_id = ${c.var.auth.memberId}`
      return c.body(null, 204)
    })

    .post('/read-all', async (c) => {
      await deps.sql`update public.notifications set read_at = ${now()} where recipient_member_id = ${c.var.auth.memberId} and read_at is null`
      return c.json({ unread: 0 })
    })

    .post('/:id/read', async (c) => {
      const id = c.req.param('id')
      if (!uuid.safeParse(id).success) throw notFound('Notification not found.')
      const [row] = await deps.sql`
        update public.notifications set read_at = coalesce(read_at, ${now()})
        where id = ${id} and recipient_member_id = ${c.var.auth.memberId} returning id
      `
      if (!row) throw notFound('Notification not found.')
      return c.body(null, 204)
    })
}
