import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
import { AppError } from '../lib/errors.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { parseBody } from '../lib/validation.js'
import { z } from 'zod'

const Complete = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(4096) })

const notSetUp = () => new AppError(409, 'zoom_not_configured', 'Zoom isn’t set up on this server yet. Add the Zoom app keys to the API’s settings first.')

/** /v1/zoom — F1.07 connect and disconnect the organisation's Zoom account (OAuth). */
export function zoomRoutes(deps: AppDeps) {
  const settingsUrl = (result: string) => `${deps.appUrl.replace(/\/$/, '')}/admin/settings/attendance?zoom=${result}`
  const now = () => (deps.now ? deps.now() : new Date())

  return (
    new Hono<{ Variables: AuthVariables }>()
      // Zoom sends the browser back here. Nothing is saved yet: the browser carries the code to the settings page,
      // which finishes with POST /complete as the signed-in admin. So a link started by someone else can't
      // attach another person's Zoom account to their organisation (security review, Nov 2026).
      .get('/callback', (c) => {
        if (!deps.zoom || !deps.zoomBox) return c.redirect(settingsUrl('not_configured'))
        const code = c.req.query('code')
        const state = c.req.query('state')
        if (!code || !state) return c.redirect(settingsUrl(c.req.query('error') === 'access_denied' ? 'cancelled' : 'error'))
        return c.redirect(`${settingsUrl('finish')}&${new URLSearchParams({ code, state })}`)
      })

      .use(requireAuth(deps), requireRole('owner', 'admin'))

      // Where to send the browser to approve Synqop in Zoom.
      .post('/connect', async (c) => {
        if (!deps.zoom || !deps.zoomBox) throw notSetUp()
        const { organisationId, memberId } = c.var.auth
        return c.json({ url: deps.zoom.authorizeUrl(deps.zoomBox.signState({ organisationId, memberId }, now().getTime())) })
      })

      // Finishes connecting: only the admin who started it, in their own organisation, within 10 minutes.
      .post('/complete', async (c) => {
        if (!deps.zoom || !deps.zoomBox) throw notSetUp()
        const body = await parseBody(c, Complete)
        const { organisationId, memberId } = c.var.auth
        const state = deps.zoomBox.readState(body.state, now().getTime())
        if (!state || state.memberId !== memberId || state.organisationId !== organisationId) {
          throw new AppError(400, 'zoom_state_invalid', 'This Zoom approval wasn’t started by you, or it has expired. Connect again.')
        }
        let tokens: Awaited<ReturnType<NonNullable<typeof deps.zoom>['exchangeCode']>>
        let me: Awaited<ReturnType<NonNullable<typeof deps.zoom>['me']>>
        try {
          tokens = await deps.zoom.exchangeCode(body.code)
          me = await deps.zoom.me(tokens.accessToken)
        } catch (error) {
          console.error('Zoom connect failed', error)
          throw new AppError(400, 'zoom_connect_failed', 'Zoom couldn’t be connected. Try again.')
        }
        const box = deps.zoomBox
        await deps.sql.begin(async (tx) => {
          await tx`
            insert into public.zoom_connections (organisation_id, zoom_account_id, zoom_user_email, refresh_token_enc, access_token_enc, access_token_expires_at, scopes, connected_by, connected_at)
            values (${organisationId}, ${me.accountId}, ${me.email}, ${box.seal(tokens.refreshToken)}, ${box.seal(tokens.accessToken)},
                    ${new Date(now().getTime() + tokens.expiresIn * 1000)}, ${tokens.scopes}, ${memberId}, ${now()})
            on conflict (organisation_id) do update set
              zoom_account_id = excluded.zoom_account_id, zoom_user_email = excluded.zoom_user_email, refresh_token_enc = excluded.refresh_token_enc,
              access_token_enc = excluded.access_token_enc, access_token_expires_at = excluded.access_token_expires_at, scopes = excluded.scopes,
              connected_by = excluded.connected_by, connected_at = excluded.connected_at, broken_at = null, broken_reason = null
          `
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'zoom.connected',
            entityType: 'organisation',
            entityId: organisationId,
            data: { email: me.email },
            requestId: c.var.requestId,
          })
        })
        return c.json({ connected: true, email: me.email })
      })

      // Meetings already created stay in Zoom; new online sessions use pasted links until Zoom is connected again.
      .delete('/connection', async (c) => {
        const { organisationId, memberId } = c.var.auth
        const [conn] = await deps.sql<{ refresh_token_enc: string | null }[]>`
          delete from public.zoom_connections where organisation_id = ${organisationId} returning refresh_token_enc
        `
        if (conn?.refresh_token_enc && deps.zoom && deps.zoomBox) {
          try {
            await deps.zoom.revoke(deps.zoomBox.open(conn.refresh_token_enc))
          } catch {
            // Best effort: Zoom forgets the app when the token expires anyway.
          }
        }
        await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'zoom.disconnected', entityType: 'organisation', entityId: organisationId, requestId: c.var.requestId })
        return c.body(null, 204)
      })
  )
}
