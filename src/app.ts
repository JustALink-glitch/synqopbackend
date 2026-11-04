import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { runScheduledJobs } from './lib/scheduler.js'
import type { TokenBox, ZoomApi } from './lib/zoom.js'
import { zoomRoutes } from './routes/zoom.js'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { rateLimit, type RateLimitOptions } from './lib/rate-limit.js'
import type { HumanCheck } from './lib/human-check.js'
import { signUpRoutes } from './routes/sign-up.js'
import type { LoadMembership, VerifyToken } from './lib/auth.js'
import type { AuthAdmin } from './lib/auth-admin.js'
import type { Sql } from './lib/db.js'
import { AppError } from './lib/errors.js'
import type { Mailer } from './lib/mailer.js'
import { flushPush, type PushSender } from './lib/push.js'
import type { FileStorage } from './lib/storage.js'
import { cohortRoutes } from './routes/cohorts.js'
import { courseRoutes } from './routes/courses.js'
import { invitationRoutes } from './routes/invitations.js'
import { cohortCourseResourceRoutes } from './routes/cohort-course-resources.js'
import { permanentDeleteRoutes } from './routes/permanent-delete.js'
import { photoRoutes } from './routes/photos.js'
import { meRoutes } from './routes/me.js'
import { memberRoutes } from './routes/members.js'
import { organisationRoutes } from './routes/organisations.js'
import { participantRoutes } from './routes/participants.js'
import { passwordResetRoutes } from './routes/password-reset.js'
import { assignmentRoutes } from './routes/assignments.js'
import { attentionRoutes } from './routes/attention.js'
import { programmeRoutes } from './routes/programmes.js'
import { feedbackRoutes } from './routes/feedback.js'
import { myRoutes } from './routes/my.js'
import { sessionRoutes } from './routes/sessions.js'
import { completionRoutes } from './routes/completion.js'
import { privacyRoutes } from './routes/privacy.js'
import { notificationRoutes } from './routes/notifications.js'
import { announcementRoutes } from './routes/announcements.js'
import { searchRoutes } from './routes/search.js'
import { exportRoutes } from './routes/exports.js'
import { overviewRoutes } from './routes/overview.js'
import { reportRoutes } from './routes/reports.js'
import { settingsRoutes } from './routes/settings.js'
import { activityRoutes } from './routes/activity.js'
import { trainerRoutes } from './routes/trainer.js'

export interface AppDeps {
  corsOrigins: string[]
  verifyToken: VerifyToken
  loadMembership: LoadMembership
  sql: Sql
  authAdmin: AuthAdmin
  mailer: Mailer
  storage: FileStorage
  /** Frontend base URL, for links in emails. */
  appUrl: string
  /** Wait for background jobs (report generation) before responding. Tests only. */
  awaitJobs?: boolean
  /** Clock, injectable for tests. */
  now?: () => Date
  /** Zoom app (F1.07). Null when this server has no Zoom keys. */
  zoom?: ZoomApi | null
  zoomBox?: TokenBox | null
  /** Starts Zoom work for an organisation just after a session changes (F1.07). Unset: the scheduler does it. */
  zoomSoon?: (organisationId: string) => void
  /** Lets an outside cron run scheduled jobs (POST /v1/internal/run-jobs). Off when unset. */
  cronSecret?: string
  /** Web push (VAPID). Off when unset: the bell and email still work. */
  push?: PushSender | null
  /** Show internal error messages in responses. Never true in production. */
  exposeErrors?: boolean
  log?: boolean
  /** Request limits (lib/rate-limit.ts). Off when unset; production turns them on in index.ts. */
  rateLimit?: RateLimitOptions
  /** Bot check for sign-up and forgot password (Turnstile). Everyone passes when unset. */
  humanCheck?: HumanCheck
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.use(requestId())
  if (deps.log !== false) app.use(logger())
  app.use(secureHeaders())
  app.use(
    cors({
      origin: (origin) => (deps.corsOrigins.includes(origin.replace(/\/$/, '')) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  )
  // After CORS, so the browser can read a 429.
  if (deps.rateLimit) app.use(rateLimit(deps.rateLimit))
  // JSON bodies only; file uploads go straight to storage via signed URLs.
  app.use(bodyLimit({ maxSize: 1024 * 1024 }))

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Each router applies its own auth. Public: invitations, password reset. Signed in, no organisation yet:
  // organisations. Everything else requires an active membership.
  app.route('/v1/invitations', invitationRoutes(deps))
  app.route('/v1/auth/sign-up', signUpRoutes(deps))
  app.route('/v1/auth/password-reset', passwordResetRoutes(deps))
  app.route('/v1/organisations', organisationRoutes(deps))
  app.route('/v1/me', meRoutes(deps))
  app.route('/v1/photos', photoRoutes(deps))
  app.route('/v1/members', memberRoutes(deps))
  app.route('/v1/programmes', programmeRoutes(deps))
  app.route('/v1/courses', courseRoutes(deps))
  app.route('/v1/cohorts', cohortRoutes(deps))
  app.route('/v1/participants', participantRoutes(deps))
  app.route('/v1/sessions', sessionRoutes(deps))
  app.route('/v1/cohort-courses', cohortCourseResourceRoutes(deps))
  app.route('/v1', permanentDeleteRoutes(deps))
  app.route('/v1/assignments', assignmentRoutes(deps))
  app.route('/v1/my', myRoutes(deps))
  app.route('/v1/session-feedback', feedbackRoutes(deps))
  app.route('/v1/attention', attentionRoutes(deps))
  app.route('/v1/trainer', trainerRoutes(deps))
  app.route('/v1/completion', completionRoutes(deps))
  app.route('/v1/settings', settingsRoutes(deps))
  app.route('/v1/activity', activityRoutes(deps))
  app.route('/v1/session-reports', reportRoutes(deps))
  app.route('/v1/overview', overviewRoutes(deps))
  app.route('/v1/reports', exportRoutes(deps))
  app.route('/v1/privacy', privacyRoutes(deps))
  app.route('/v1/notifications', notificationRoutes(deps))
  app.route('/v1/announcements', announcementRoutes(deps))
  app.route('/v1/search', searchRoutes(deps))
  app.route('/v1/zoom', zoomRoutes(deps))

  // X2: for hosts that sleep between requests, an outside cron can run the scheduled jobs.
  app.post('/v1/internal/run-jobs', async (c) => {
    const given = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
    const expected = deps.cronSecret ?? ''
    const ok = expected.length > 0 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    if (!ok) return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
    const ran = await runScheduledJobs(deps, deps.now?.())
    const pushed = deps.push ? await flushPush({ sql: deps.sql, push: deps.push }) : 0
    return c.json({ ran: { ...ran, pushed } })
  })

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404))

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status)
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status)
    }
    console.error(`[${c.var.requestId}]`, err)
    return c.json(
      {
        error: {
          code: 'internal_error',
          message: deps.exposeErrors ? err.message : 'Something went wrong. Try again.',
          requestId: c.var.requestId,
        },
      },
      500,
    )
  })

  return app
}

export type App = ReturnType<typeof createApp>
