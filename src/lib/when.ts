/** 90 → "1h 30m", 120 → "2h", 45 → "45m". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
}

/** "2h (22:00–00:30, next day)" in a time zone — duration first (pilot feedback, Nov 2026). */
export function clockRange(start: Date, end: Date, timeZone: string): string {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d)
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const nextDay = day(end) > day(start)
  return `${durationText((end.getTime() - start.getTime()) / 60_000)} (${time(start)}–${time(end)}${nextDay ? ', next day' : ''})`
}
