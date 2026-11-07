export type TtmlProfile = 'standard' | 'zvonko'

type ExportLine = { text: string; start: number | null; end: number | null }
export type TtmlOptions = {
  duration: number
  profile: TtmlProfile
  title: string
  artist: string
  language: 'en-US' | 'ru-RU'
}
export type ExportIssue = { line: number | null; code: string; message: string }

const pad = (value: number, width = 2) => String(value).padStart(width, '0')
const milliseconds = (time: number) => Math.round(time * 1000)
const invalidXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u

export function formatTtmlTime(time: number) {
  const total = milliseconds(Math.max(0, time))
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`
}

export function formatLrcTime(time: number) {
  const total = Math.round(Math.max(0, time) * 100)
  return `${pad(Math.floor(total / 6000))}:${pad(Math.floor(total / 100) % 60)}.${pad(total % 100)}`
}

export function validateTtml(lines: ExportLine[], options: TtmlOptions): ExportIssue[] {
  const issues: ExportIssue[] = []
  const add = (line: number | null, code: string, message: string) => issues.push({ line, code, message })
  const durationKnown = Number.isFinite(options.duration) && options.duration > 0
  if (!durationKnown) add(null, 'Audio duration', 'Wait for the audio to load before exporting.')
  if (!lines.length) add(null, 'No lyrics', 'Add at least one lyric line.')
  if (options.profile === 'zvonko') {
    if (invalidXml.test(options.title + options.artist)) add(null, 'Invalid text', 'Metadata contains unsupported XML characters.')
  }
  let latestEnd = -1
  let latestLine = 0
  lines.forEach((line, index) => {
    const number = index + 1
    if (!line.text.trim()) add(number, 'Empty line', 'Enter text or delete this line.')
    if (invalidXml.test(line.text)) add(number, 'Invalid text', 'Remove unsupported XML characters.')
    const { start, end } = line
    if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
      add(number, 'Missing timing', 'Set both Start and End.')
      return
    }
    if (start < 0 || end < 0) add(number, 'Negative time', 'Start and End must be zero or greater.')
    if (end <= start || milliseconds(end) <= milliseconds(start)) {
      add(number, 'Invalid interval', 'End must follow Start by at least one exported millisecond.')
    }
    if (durationKnown && (start > options.duration || end > options.duration)) {
      add(number, 'Exceeding Time', `Timing exceeds the audio duration (${formatTtmlTime(options.duration)}).`)
    }
    if (start < latestEnd || milliseconds(start) < milliseconds(latestEnd)) {
      add(number, 'Time Crossing', `Start precedes the end of line ${latestLine}.`)
    }
    if (end > latestEnd) {
      latestEnd = end
      latestLine = number
    }
  })
  return issues
}

const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

export function exportTtml(lines: ExportLine[], options: TtmlOptions) {
  const issues = validateTtml(lines, options)
  if (issues.length) throw new Error(issues.map(issue => `${issue.line ? `Line ${issue.line}: ` : ''}${issue.code} - ${issue.message}`).join('\n'))
  const body = lines.map(line => `      <p begin="${formatTtmlTime(line.start!)}" end="${formatTtmlTime(line.end!)}">${escapeXml(line.text.trim())}</p>`).join('\n')
  if (options.profile === 'standard') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
${body}
    </div>
  </body>
</tt>`
  }
  const title = options.title.trim()
  const artist = options.artist.trim()
  const metadata = [
    title ? `    <metadata>\n      <ttm:title>${escapeXml(title)}</ttm:title>\n    </metadata>` : '',
    artist ? `    <ttm:agent xml:id="voice1" type="person">\n      <ttm:name type="full">${escapeXml(artist)}</ttm:name>\n    </ttm:agent>` : '',
  ].filter(Boolean).join('\n')
  const head = metadata ? `\n  <head>\n${metadata}\n  </head>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="${options.language}">${head}
  <body>
    <div>
${body}
    </div>
  </body>
</tt>`
}

export function ttmlFilename(options: TtmlOptions, fallback: string) {
  const metadataName = [options.title.trim(), options.artist.trim()].filter(Boolean).join(' - ')
  const name = options.profile === 'zvonko' && metadataName ? metadataName : fallback
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '') + '.ttml'
}
