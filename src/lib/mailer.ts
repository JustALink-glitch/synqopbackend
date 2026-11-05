export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
  /** Shown as the sender's name: "Mindspark Inc via Synqop". The address stays Synqop's own. */
  fromName?: string
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>
}

/** Development: print the email (including links) to the console instead of sending it. */
export function createConsoleMailer(): Mailer {
  return {
    async send(message) {
      console.info(`\n── email to ${message.to} ──\nSubject: ${message.subject}\n\n${message.text}\n──\n`)
    },
  }
}

/** "Synqop <notifications@mail.synqop.com>" + "Mindspark Inc" → "Mindspark Inc via Synqop <notifications@mail.synqop.com>". */
export function senderAs(from: string, organisationName: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim()
  // Characters that would break the From header (quotes, brackets, separators, line breaks) are dropped.
  const name = organisationName.replace(/["<>\\,;:@\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return name ? `"${name} via Synqop" <${address}>` : from
}

/** Production: send through Resend (https://resend.com). */
export function createResendMailer(options: { apiKey: string; from: string }): Mailer {
  return {
    async send(message) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: message.fromName ? senderAs(options.from, message.fromName) : options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      })
      if (!response.ok) {
        throw new Error(`Resend rejected the email (${response.status}): ${await response.text()}`)
      }
    },
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** The Synqop logo (Nov 2026 identity), hosted with the web app; the alt text shows where images are blocked. */
const EMAIL_LOGO = 'https://app.synqop.com/email-logo.png'

/** Brand tokens (Synqop Marketing & Design › Product emails v1). Geist first; Arial where a mail app can't load it. */
const C = {
  ink: '#0E131A',
  body: '#334155',
  muted: '#5C6777',
  subtle: '#76808D',
  line: '#E7ECF1',
  canvas: '#EFF2F6',
  band: '#F8FAFC',
  blue: '#2563EB',
}
const FONT = "Geist,'Helvetica Neue',Helvetica,Arial,sans-serif"

/** Status tag above the title: a coloured dot and a short label ("Session cancelled", "Export ready"). */
export type EmailTone = 'blue' | 'green' | 'amber' | 'red'
const TONES: Record<EmailTone, { dot: string; text: string }> = {
  blue: { dot: '#2563EB', text: '#1A46A7' },
  green: { dot: '#16A34A', text: '#107435' },
  amber: { dot: '#D97706', text: '#9A5404' },
  red: { dot: '#DC2626', text: '#9C1B1B' },
}

export interface EmailSection {
  /** Small capitals heading, e.g. "New flags · 25". */
  heading: string
  items: { title: string; meta?: string; tone?: EmailTone }[]
  /** "and 20 more", shown under the list. */
  more?: string
}

export interface EmailInput {
  title: string
  intro: string
  /** Shown top-right and in the footer ("Sent by Mindspark Inc through Synqop"). Leave out for Synqop's own emails. */
  organisationName?: string
  status?: { label: string; tone: EmailTone }
  /** Label / value rows under the intro (X2 frames: When, Where, Trainer…). */
  details?: { label: string; value: string }[]
  /** Lists for digests: flagged participants, overdue reports, submissions to grade. */
  sections?: EmailSection[]
  buttonLabel: string
  buttonUrl: string
  note?: string
  /** "Button not working? Paste this into your browser: …" */
  showLinkFallback?: boolean
  /** Why they got it, under the sender line. */
  footer?: string
}

/**
 * The shared transactional template (X2 / Product emails v1). Every product email goes through here,
 * so a change to this function restyles all of them. Tables and inline styles, so Gmail and Outlook agree.
 */
export function renderEmail(input: EmailInput) {
  const sender = input.organisationName ? `Sent by ${input.organisationName} through Synqop.` : 'Synqop · www.synqop.com'
  const text = [
    input.status ? `[${input.status.label}]` : '',
    input.title,
    '',
    input.intro,
    '',
    ...(input.details?.length ? [...input.details.map((d) => (d.label ? `${d.label}: ${d.value}` : `  ${d.value}`)), ''] : []),
    ...(input.sections ?? []).flatMap((s) => [s.heading.toUpperCase(), ...s.items.map((i) => `- ${i.title}${i.meta ? ` (${i.meta})` : ''}`), ...(s.more ? [`  ${s.more}`] : []), '']),
    `${input.buttonLabel}: ${input.buttonUrl}`,
    input.note ? `\n${input.note}` : '',
    '',
    '—',
    sender,
    input.footer ?? '',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const e = escapeHtml
  const cell = (style: string, html: string) => `<tr><td style="${style}">${html}</td></tr>`
  const divider = `border-top:1px solid ${C.line}`

  const status = input.status
    ? cell(
        'padding:0 0 12px',
        `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${TONES[input.status.tone].dot};vertical-align:middle"></span>&nbsp;<span style="font-size:12px;line-height:16px;font-weight:500;color:${TONES[input.status.tone].text};vertical-align:middle">${e(input.status.label)}</span>`,
      )
    : ''

  const details = input.details?.length
    ? cell(
        'padding:0 0 24px',
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${input.details
          .map(
            (d) =>
              `<tr><td class="lbl" style="font-size:13px;line-height:20px;color:${C.subtle};padding:10px 16px 10px 0;width:32%;vertical-align:top;${divider}">${e(d.label)}</td><td style="font-size:14px;line-height:20px;color:${C.ink};padding:10px 0;vertical-align:top;${divider}">${e(d.value)}</td></tr>`,
          )
          .join('')}<tr><td colspan="2" style="${divider};font-size:0;line-height:0">&nbsp;</td></tr></table>`,
      )
    : ''

  const sections = (input.sections ?? [])
    .map((s) =>
      cell(
        'padding:0 0 24px',
        `<div style="font-size:11px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;color:${C.subtle};padding:0 0 8px">${e(s.heading)}</div>` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${s.items
            .map((it) => {
              const dot = it.tone ? `<span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:${TONES[it.tone].dot};vertical-align:middle;margin-right:8px"></span>` : ''
              return `<tr><td style="${divider};padding:10px 0">${dot}<span style="font-size:14px;line-height:20px;font-weight:500;color:${C.ink};vertical-align:middle">${e(it.title)}</span>${
                it.meta ? `<div style="font-size:12px;line-height:18px;color:${C.subtle};padding:2px 0 0${it.tone ? ';padding-left:14px' : ''}">${e(it.meta)}</div>` : ''
              }</td></tr>`
            })
            .join('')}<tr><td style="${divider};font-size:0;line-height:0">&nbsp;</td></tr></table>` +
          (s.more ? `<div style="font-size:13px;line-height:20px;color:${C.muted};padding:4px 0 0">${e(s.more)}</div>` : ''),
      ),
    )
    .join('')

  // Bulletproof button: the table cell carries the colour, so Outlook still shows a blue block.
  const button = cell(
    'padding:0 0 24px',
    `<table role="presentation" cellpadding="0" cellspacing="0" class="btn"><tr><td bgcolor="${C.blue}" style="border-radius:8px;background:${C.blue}"><a href="${e(input.buttonUrl)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px">${e(input.buttonLabel)}</a></td></tr></table>`,
  )

  const html = `<!doctype html>
<html lang="en-GB" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${e(input.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{color-scheme:light only;supported-color-schemes:light only}
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a{color:${C.blue}}
  @media (max-width:620px){
    .outer{padding:0!important}
    .pad{padding-left:24px!important;padding-right:24px!important}
    .padh{padding-left:14px!important;padding-right:14px!important}
    .lbl{width:38%!important}
    .btn,.btn td,.btn a{display:block!important;width:100%!important;text-align:center!important;box-sizing:border-box}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:${FONT};color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.canvas}">${e(input.intro.slice(0, 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.canvas}" style="background:${C.canvas}">
  <tr><td align="center" class="outer" style="padding:32px 16px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:${FONT}">
      <tr><td class="padh" style="padding:26px 30px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:0 0 26px;vertical-align:middle">
              <!-- The logo sits on a white tile drawn as a gradient: the Gmail apps repaint colours in dark mode
                   but leave gradients alone, so the dark wordmark stays readable. Invisible on the white card. -->
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;background-image:linear-gradient(#FFFFFF,#FFFFFF);border-radius:6px;padding:6px 10px"><img src="${EMAIL_LOGO}" width="110" height="24" alt="Synqop" style="display:block;border:0;height:24px;width:110px;font-size:16px;font-weight:700;color:${C.blue}"></td></tr></table>
            </td>
            ${input.organisationName ? `<td align="right" style="padding:0 10px 26px 16px;vertical-align:middle;font-size:12px;line-height:16px;color:${C.subtle}">${e(input.organisationName)}</td>` : ''}
          </tr>
        </table>
      </td></tr>
      <tr><td class="pad" style="padding:0 40px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${status}
          ${cell(`padding:0 0 12px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:${C.ink}`, e(input.title))}
          ${cell(`padding:0 0 24px;font-size:14px;line-height:22px;color:${C.body};white-space:pre-line`, e(input.intro))}
          ${details}
          ${sections}
          ${button}
          ${input.note ? cell(`padding:0 0 16px;font-size:12px;line-height:18px;color:${C.subtle}`, e(input.note)) : ''}
          ${input.showLinkFallback ? cell(`padding:0 0 16px;font-size:12px;line-height:18px;color:${C.subtle};word-break:break-all`, `Button not working? Paste this into your browser:<br><a href="${e(input.buttonUrl)}" style="color:${C.blue}">${e(input.buttonUrl)}</a>`) : ''}
        </table>
      </td></tr>
      <tr><td class="pad" bgcolor="${C.band}" style="background:${C.band};padding:20px 40px 24px;margin-top:8px;font-size:12px;line-height:18px;color:${C.subtle}">
        ${e(sender)}${input.footer ? `<br>${e(input.footer)}` : ''}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`

  return { text, html }
}
