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
    // Same answer whether or not the email has an account, so sign-up can't be used to find out who uses Synqop.
    // The owner of an existing account gets a note pointing them to sign in instead.
    if (!result.ok) {
      const existing = renderEmail({
        title: 'You already have a Synqop account',
        intro: `Someone tried to create a Synqop account with ${body.email}, but this email already has one. If it was you, sign in instead, or reset your password if you’ve forgotten it.`,
        buttonLabel: 'Sign in',
        buttonUrl: new URL('/sign-in', deps.appUrl).toString(),
        note: `Forgotten your password? ${new URL('/forgot-password', deps.appUrl).toString()}`,
        footer: 'Didn’t try to sign up? Ignore this email. Nothing has changed on your account.',
      })
      await deps.mailer.send({ to: body.email, subject: 'You already have a Synqop account', text: existing.text, html: existing.html })
      return c.json({ sent: true }, 201)
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
