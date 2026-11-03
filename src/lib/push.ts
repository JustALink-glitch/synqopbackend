import webpush from 'web-push'
import type { Sql } from './db.js'

export interface PushSubscriptionKeys {
  endpoint: string
  p256dh: string
  auth: string
}

/** 'gone' means the browser dropped the subscription (404/410): forget it. */
export type PushResult = 'sent' | 'gone' | 'failed'

export interface PushSender {
  publicKey: string
  send(subscription: PushSubscriptionKeys, payload: string): Promise<PushResult>
}

export function createWebPushSender(options: { publicKey: string; privateKey: string; subject: string }): PushSender {
  webpush.setVapidDetails(options.subject, options.publicKey, options.privateKey)
  return {
    publicKey: options.publicKey,
    async send(s, payload) {
      try {
        // A day is long enough for a phone that's off overnight; older news is still in the bell.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86_400, urgency: 'normal' })
        return 'sent'
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) return 'gone'
        console.error('Push failed', status ?? error)
        return 'failed'
      }
    },
  }
}

/**
 * Pushes every new in-app notification to the recipient's devices (G1.01). Runs every few seconds in the API,
 * so it only sees notifications whose transaction committed. Anything older than an hour is left to the bell.
 */
export async function flushPush(deps: { sql: Sql; push: PushSender }, now = new Date()) {
  const rows = await deps.sql.begin(async (tx) => {
    const picked = await tx<{ id: string; member: string; title: string; body: string | null; link: string | null }[]>`
      select n.id, n.recipient_member_id as member, n.title, n.body, n.link_path as link from public.notifications n
      where n.pushed_at is null and n.created_at > ${now}::timestamptz - interval '1 hour'
      order by n.created_at limit 200 for update skip locked
    `
    if (picked.length) await tx`update public.notifications set pushed_at = ${now} where id = any(${picked.map((r) => r.id)}::uuid[])`
    return picked
  })
  if (!rows.length) return 0
  const subs = await deps.sql<(PushSubscriptionKeys & { id: string; member: string })[]>`
    select id, member_id as member, endpoint, p256dh, auth from public.push_subscriptions
    where member_id = any(${[...new Set(rows.map((r) => r.member))]}::uuid[])
  `
  if (!subs.length) return 0
  const unread = await deps.sql<{ member: string; n: number }[]>`
    select recipient_member_id as member, count(*)::int as n from public.notifications
    where read_at is null and recipient_member_id = any(${[...new Set(subs.map((s) => s.member))]}::uuid[]) group by 1
  `
  const badge = new Map(unread.map((u) => [u.member, u.n]))
  let sent = 0
  const gone: string[] = []
  const used: string[] = []
  for (const n of rows) {
    const payload = JSON.stringify({ id: n.id, title: n.title, body: n.body ?? '', link: n.link ?? '/', unread: badge.get(n.member) ?? 0 })
    for (const s of subs.filter((s) => s.member === n.member)) {
      const result = await deps.push.send(s, payload)
      if (result === 'sent') {
        sent++
        used.push(s.id)
      } else if (result === 'gone') gone.push(s.id)
    }
  }
  if (gone.length) await deps.sql`delete from public.push_subscriptions where id = any(${gone}::uuid[])`
  if (used.length) await deps.sql`update public.push_subscriptions set last_used_at = ${now} where id = any(${[...new Set(used)]}::uuid[])`
  return sent
}

export function startPush(deps: { sql: Sql; push: PushSender }, everyMs = 5_000) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await flushPush(deps)
    } catch (error) {
      console.error('Push run failed', error)
    } finally {
      running = false
    }
  }, everyMs)
  return () => clearInterval(timer)
}
