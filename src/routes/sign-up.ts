import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { allowAll } from '../lib/human-check.js'
import { AppError } from '../lib/errors.js'
import { renderEmail } from '../lib/mailer.js'
import { email, fullName, parseBody, password } from '../lib/validation.js'

const SignUp = z.object({ fullName, email, password, captchaToken: z.string().optional() })

export const captchaFailed = () => new AppError(400, 'captcha_failed', 'We couldn’t check you’re not a robot. Try again.')

/**
 * POST /v1/auth/sign-up — R1.01 Create account.
 * Runs on the API (not straight to Supabase) so the bot check can't be skipped, and so the confirmation
 * email uses the Synqop template. Supabase's own public sign-up can then be switched off.
 * The account stays unconfirmed until the person clicks the link; then they create their organisation (R1.02).
 */
export function signUpRoutes(deps: AppDeps) {
  const isHuman = deps.humanCheck ?? allowAll
  return new Hono().post('/', async (c) => {
    const body = await parseBody(c, SignUp)
    if (!(await isHuman(body.captchaToken))) throw captchaFailed()

    const name = `${body.fullName.firstName} ${body.fullName.lastName}`
    const redirectTo = new URL('/signup/organisation', deps.appUrl).toString()
    const result = await deps.authAdmin.generateSignupLink({ email: body.email, password: body.password, name, redirectTo })
    if (!result.ok && result.reason === 'weak_password') throw new AppError(400, 'weak_password', 'Choose a stronger password.')
    // Pilot feedback (Nov 2026, owner's decision): say so on screen instead of emailing. This tells anyone who tries
    // that the email uses Synqop; the sign-up request limit (10 an hour per IP) keeps that from being done in bulk.
    if (!result.ok) {
      throw new AppError(409, 'account_exists', 'You already have a Synqop account with this email. Sign in instead, or reset your password.', [
        { field: 'email', message: 'You already have a Synqop account with this email.' },
      ])
    }

    const { text, html } = renderEmail({
      title: 'Confirm your email',
      intro: `Hi ${body.fullName.firstName}, confirm this is your email to finish creating your Synqop account. Then you’ll set up your organisation.`,
      buttonLabel: 'Confirm email',
      buttonUrl: result.link,
      note: 'This link works once and expires in 24 hours.',
      showLinkFallback: true,
      footer: 'Didn’t create a Synqop account? Ignore this email and no account will be set up.',
    })
    await deps.mailer.send({ to: body.email, subject: 'Confirm your email for Synqop', text, html })
    return c.json({ sent: true }, 201)
  })
}
