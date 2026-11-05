/**
 * Email previews (Product emails v1).
 *
 *   npm run email:preview                     → writes every email type to email-previews/*.html
 *   npm run email:preview -- --send you@x.com → also sends each one to that address through Resend
 *
 * Sending reads RESEND_API_KEY and EMAIL_FROM from your .env, on your machine. Nothing here changes
 * the database or emails anyone else. The sample content mirrors what the API sends for each event.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createResendMailer, renderEmail, type EmailInput } from '../src/lib/mailer.js'

const ORG = 'Mindspark Inc'
const APP = 'https://app.synqop.com'

const samples: { file: string; subject: string; fromOrg: boolean; input: EmailInput }[] = [
  {
    file: '01-invitation',
    subject: `You're invited to ${ORG} on Synqop`,
    fromOrg: true,
    input: {
      title: `You're invited to ${ORG}`,
      organisationName: ORG,
      intro: `Hi Hussaini, you've been added to ${ORG} on Synqop as a participant. Set a password to get started.`,
      buttonLabel: 'Set your password',
      buttonUrl: `${APP}/invite/sample-token`,
      note: 'This link works once and expires in 72 hours. If you weren’t expecting it, you can ignore this email.',
    },
  },
  {
    file: '02-confirm-email',
    subject: 'Confirm your email for Synqop',
    fromOrg: false,
    input: {
      title: 'Confirm your email',
      intro: 'Hi Michael, confirm this is your email to finish creating your Synqop account. Then you’ll set up your organisation.',
      buttonLabel: 'Confirm email',
      buttonUrl: `${APP}/sign-up/confirm?sample=1`,
      note: 'This link works once and expires in 24 hours.',
      showLinkFallback: true,
      footer: 'Didn’t create a Synqop account? Ignore this email and no account will be set up.',
    },
  },
  {
    file: '03-password-reset',
    subject: 'Reset your Synqop password',
    fromOrg: false,
    input: {
      title: 'Reset your password',
      intro: 'Hi Michael, someone asked to reset the password for michael@example.com on Synqop. If it was you, choose a new one below.',
      buttonLabel: 'Choose a new password',
      buttonUrl: `${APP}/reset-password?sample=1`,
      note: 'This link works once and expires in 1 hour, at 15:20.',
      showLinkFallback: true,
      footer: `Didn’t ask for this? Ignore this email — your password stays the same. Nobody at Synqop or ${ORG} will ever ask for your password.`,
    },
  },
  {
    file: '04-session-cancelled',
    subject: 'Cancelled: Data Visualization Basics, Sat 7 Nov 09:00',
    fromOrg: true,
    input: {
      title: 'Cancelled: Data Visualization Basics, Sat 7 Nov 09:00',
      organisationName: ORG,
      status: { label: 'Session cancelled', tone: 'red' },
      intro: 'Hi Hussaini, this session is cancelled. Reason: Trainer unavailable',
      details: [{ label: 'Session', value: 'DA 101 — Data Overview and Basics · Sat 7 Nov · 09:00–12:00 WAT' }],
      buttonLabel: 'Open Synqop',
      buttonUrl: `${APP}/sign-in`,
    },
  },
  {
    file: '05-session-changed',
    subject: 'Data Visualization Basics: session changed',
    fromOrg: true,
    input: {
      title: 'Data Visualization Basics: session changed',
      organisationName: ORG,
      status: { label: 'Session changed', tone: 'amber' },
      intro: 'Hi Hussaini, the session on Sat 7 Nov now starts at 10:00 WAT instead of 09:00. The Zoom link stays the same.',
      buttonLabel: 'Open Synqop',
      buttonUrl: `${APP}/sign-in`,
    },
  },
  {
    file: '06-admin-morning-digest',
    subject: 'Synqop daily digest — Thu 5 Nov',
    fromOrg: true,
    input: {
      title: 'Your morning digest',
      organisationName: ORG,
      status: { label: 'Daily digest · Thu 5 Nov', tone: 'blue' },
      intro: 'Hi Michael, here’s what changed since yesterday at 08:00.',
      sections: [
        {
          heading: 'New flags · 25',
          items: [
            { title: 'Muhammad Abubakry', meta: 'First Cohorts 2026 · missed 3 sessions in a row', tone: 'amber' },
            { title: 'Zubair Olayinka', meta: 'First Cohorts 2026 · attendance 33%', tone: 'amber' },
            { title: 'Bewaji Daniel', meta: 'First Cohorts 2026 · 2 assignments overdue', tone: 'amber' },
            { title: 'Adaeze Ibrahim', meta: 'DA 101 · no activity for 10 days', tone: 'amber' },
            { title: 'Francis Ekezie', meta: 'DA 101 · attendance 0%', tone: 'amber' },
          ],
          more: 'and 20 more',
        },
        { heading: 'Reports overdue · 1', items: [{ title: 'Data Visualization Basics', meta: 'Session on Tue 3 Nov · Aisha Bello' }] },
      ],
      buttonLabel: 'Open Needs attention',
      buttonUrl: `${APP}/admin/needs-attention`,
      footer: 'Sent at 08:00 because the daily digest is on. Change it in Settings › Notifications.',
    },
  },
  {
    file: '07-trainer-to-grade',
    subject: '7 submissions waiting for your grade',
    fromOrg: true,
    input: {
      title: 'Submissions to grade',
      organisationName: ORG,
      intro: 'Hi Aisha, these submissions are waiting for your grade, oldest deadline first.',
      sections: [
        {
          heading: 'Waiting for your grade · 7',
          items: [
            { title: 'Chart critique', meta: 'First Cohorts 2026 · 4 to grade' },
            { title: 'Dashboard draft', meta: 'First Cohorts 2026 · 3 to grade' },
          ],
        },
      ],
      buttonLabel: 'Open grading',
      buttonUrl: `${APP}/trainer/grading`,
      footer: 'Sent at 08:00 because grading reminders are on. Change them in Settings.',
    },
  },
  {
    file: '08-certificate-ready',
    subject: 'Your certificate is ready',
    fromOrg: true,
    input: {
      title: 'Your certificate is ready',
      organisationName: ORG,
      status: { label: 'Programme completed', tone: 'green' },
      intro: 'Hi Hussaini, you’ve completed Data Analytics · First Cohorts 2026. Congratulations — your certificate is ready to download.',
      buttonLabel: 'View certificate',
      buttonUrl: `${APP}/participant/grades/certificate`,
    },
  },
  {
    file: '09-export-ready',
    subject: `${ORG} data export is ready`,
    fromOrg: false,
    input: {
      title: 'Your data export is ready',
      status: { label: 'Export ready', tone: 'green' },
      intro: `Hi Michael, the export of ${ORG}’s data you asked for is ready to download.`,
      buttonLabel: 'Download export',
      buttonUrl: `${APP}/admin/settings/privacy`,
      note: 'The download works for 7 days. You’ll need to sign in as the owner.',
    },
  },
  {
    file: '10-deletion-scheduled',
    subject: `${ORG} is scheduled for deletion`,
    fromOrg: false,
    input: {
      title: `${ORG} is scheduled for deletion`,
      organisationName: ORG,
      status: { label: 'Deletion scheduled', tone: 'red' },
      intro: `Hi Michael, ${ORG}’s Synqop workspace will be permanently deleted on Sat 5 Dec. Until then it’s read-only. An owner can export data or cancel the deletion.`,
      buttonLabel: 'Open Data & privacy',
      buttonUrl: `${APP}/admin/settings/privacy`,
    },
  },
]

const outDir = join(process.cwd(), 'email-previews')
mkdirSync(outDir, { recursive: true })
for (const s of samples) {
  const { html, text } = renderEmail(s.input)
  writeFileSync(join(outDir, `${s.file}.html`), html)
  writeFileSync(join(outDir, `${s.file}.txt`), text)
}
console.info(`Wrote ${samples.length} previews to ${outDir}`)

const sendIndex = process.argv.indexOf('--send')
if (sendIndex !== -1) {
  const to = process.argv[sendIndex + 1]
  const apiKey = process.env.RESEND_API_KEY
  if (!to || !to.includes('@')) throw new Error('Give an address: npm run email:preview -- --send you@example.com')
  if (!apiKey) throw new Error('RESEND_API_KEY is not set in your .env, so nothing was sent.')
  const mailer = createResendMailer({ apiKey, from: process.env.EMAIL_FROM ?? 'Synqop <notifications@mail.synqop.com>' })
  for (const s of samples) {
    const { html, text } = renderEmail(s.input)
    await mailer.send({ to, subject: `[Test] ${s.subject}`, text, html, fromName: s.fromOrg ? ORG : undefined })
    console.info(`Sent ${s.file}`)
    // Resend's free plan allows 2 requests a second.
    await new Promise((r) => setTimeout(r, 600))
  }
  console.info(`Sent ${samples.length} test emails to ${to}`)
}
