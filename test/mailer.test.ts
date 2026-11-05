import { describe, expect, it } from 'vitest'
import { renderEmail, senderAs } from '../src/lib/mailer.js'

describe('shared email template (Product emails v1)', () => {
  it('shows the organisation, a status tag, details and list sections', () => {
    const { html, text } = renderEmail({
      title: 'Data Visualization Basics on Sat 7 Nov is cancelled',
      organisationName: 'Mindspark Inc',
      status: { label: 'Session cancelled', tone: 'red' },
      intro: 'Hi Hussaini, this session won’t go ahead as planned.',
      details: [{ label: 'When', value: 'Sat 7 Nov · 09:00–12:00 WAT' }],
      sections: [{ heading: 'New flags · 2', items: [{ title: 'Ada Obi', meta: 'Cohort 5 · attendance 33%', tone: 'amber' }], more: 'and 1 more' }],
      buttonLabel: 'View my schedule',
      buttonUrl: 'https://app.synqop.com/sign-in',
      footer: 'You get this because you’re enrolled in DA 101.',
    })
    expect(html).toContain('Mindspark Inc</td>')
    expect(html).toContain('Session cancelled')
    expect(html).toContain('New flags · 2')
    expect(html).toContain('Sent by Mindspark Inc through Synqop.')
    expect(text).toContain('[Session cancelled]')
    expect(text).toContain('When: Sat 7 Nov · 09:00–12:00 WAT')
    expect(text).toContain('- Ada Obi (Cohort 5 · attendance 33%)')
  })

  it('escapes what people typed', () => {
    const { html } = renderEmail({ title: '<b>x</b>', organisationName: 'A & B', intro: '"hi"', buttonLabel: 'Go', buttonUrl: 'https://x.test/?a=1&b=2' })
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('https://x.test/?a=1&amp;b=2')
  })

  it('signs Synqop’s own emails as Synqop', () => {
    const { html } = renderEmail({ title: 'Confirm your email', intro: 'Hi', buttonLabel: 'Confirm', buttonUrl: 'https://x.test' })
    expect(html).toContain('Synqop · www.synqop.com')
  })

  it('sends as "Organisation via Synqop" from Synqop’s own address', () => {
    expect(senderAs('Synqop <notifications@mail.synqop.com>', 'Mindspark Inc')).toBe('"Mindspark Inc via Synqop" <notifications@mail.synqop.com>')
    expect(senderAs('notifications@mail.synqop.com', 'A "B" <C>\r\nBcc: x@y')).toBe('"A B C Bcc x y via Synqop" <notifications@mail.synqop.com>')
    expect(senderAs('Synqop <n@mail.synqop.com>', '  ')).toBe('Synqop <n@mail.synqop.com>')
  })
})
