/**
 * Bot check (Cloudflare Turnstile) for public forms: sign-up and forgot password.
 * The browser shows the widget and sends its token; we confirm it with Cloudflare.
 * Without TURNSTILE_SECRET_KEY (local development) every request passes.
 */
export type HumanCheck = (token: string | undefined) => Promise<boolean>

export const allowAll: HumanCheck = async () => true

export function createTurnstileCheck(secret: string, fetchImpl: typeof fetch = fetch): HumanCheck {
  return async (token) => {
    if (!token || token.length > 2048) return false
    try {
      const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { success?: boolean }
      return body.success === true
    } catch (error) {
      console.error('Turnstile check failed', error)
      return false
    }
  }
}
