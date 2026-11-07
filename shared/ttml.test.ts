import assert from 'node:assert/strict'
import test from 'node:test'
import { exportTtml, formatLrcTime, formatTtmlTime, ttmlFilename, validateTtml } from './ttml.ts'

const options = { duration: 257.910438, profile: 'zvonko' as const, title: 'трек', artist: 'артист', language: 'en-US' as const }
const lines = [{ text: 'я', start: 14.592, end: 16.984 }, { text: 'крутой', start: 17.588, end: 19.677 }]

test('carries rounded milliseconds across minutes and hours', () => {
  assert.equal(formatTtmlTime(59.9996), '00:01:00.000')
  assert.equal(formatTtmlTime(3599.9996), '01:00:00.000')
  assert.equal(formatLrcTime(59.9996), '01:00.000')
  assert.equal(formatTtmlTime(14.592), '00:00:14.592')
})

test('LRC uses three fractional digits and total minutes without an hours field', () => {
  for (const [input, expected] of [
    [0, '00:00.000'], [14.592, '00:14.592'], [0.0006, '00:00.001'],
    [59.9994, '00:59.999'], [59.9996, '01:00.000'],
    [3599.9996, '60:00.000'], [3600.123, '60:00.123'], [-1, '00:00.000'],
  ] as const) assert.equal(formatLrcTime(input), expected)
})
test('exports the Zvonko reference structure and metadata', () => {
  const result = exportTtml(lines, options)
  assert(result.includes('xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions"'))
  assert(result.includes('<ttm:title>трек</ttm:title>'))
  assert(result.includes('<ttm:agent xml:id="voice1" type="person">'))
  assert(result.includes('<ttm:name type="full">артист</ttm:name>'))
  assert(result.includes('<p begin="00:00:14.592" end="00:00:16.984">я</p>'))
  assert.equal(ttmlFilename(options, 'demo'), 'трек - артист.ttml')
})
test('escapes XML and retains Russian lyrics and language', () => {
  const result = exportTtml([{ ...lines[0], text: ' Ты & я <вместе> ' }], { ...options, title: '"A&B"', language: 'ru-RU' })
  assert(result.includes('xml:lang="ru-RU"'))
  assert(result.includes('&quot;A&amp;B&quot;'))
  assert(result.includes('>Ты &amp; я &lt;вместе&gt;</p>'))
})
test('standard exports keep the minimal structure and do not require metadata', () => {
  const result = exportTtml(lines, { ...options, profile: 'standard', title: '', artist: '' })
  assert(result.includes('<tt xmlns="http://www.w3.org/ns/ttml">'))
  assert(!result.includes('ttm:title'))
})
test('identifies exact rows exceeding duration and crossing earlier intervals', () => {
  assert(validateTtml([{ text: 'a', start: 0, end: 300 }], options).some(issue => issue.code === 'Exceeding Time' && issue.line === 1))
  const crossing = [{ text: 'a', start: 1, end: 10 }, { text: 'b', start: 2, end: 3 }, { text: 'c', start: 4, end: 5 }]
  assert.deepEqual(validateTtml(crossing, options).filter(issue => issue.code === 'Time Crossing').map(issue => issue.line), [2, 3])
})
test('accepts adjacent lines and a final end exactly at the audio duration', () => {
  assert.deepEqual(validateTtml([{ text: 'a', start: 0, end: 5 }, { text: 'b', start: 5, end: options.duration }], options), [])
})
test('blocks missing, nonfinite, negative, reversed, empty and submillisecond intervals', () => {
  for (const line of [
    { text: 'a', start: null, end: 3 }, { text: 'a', start: 1, end: Infinity },
    { text: 'a', start: -1, end: 3 }, { text: 'a', start: 5, end: 4 },
    { text: '', start: 1, end: 2 }, { text: 'a', start: 1.0001, end: 1.0002 },
  ]) assert.throws(() => exportTtml([line], options))
  assert.throws(() => exportTtml(lines, { ...options, duration: 0 }))
})

test('Zvonko exports without metadata when both optional fields are blank', () => {
  const blank = { ...options, title: '  ', artist: '' }
  assert.deepEqual(validateTtml(lines, blank), [])
  const result = exportTtml(lines, blank)
  assert(result.includes('xmlns:itunes='))
  assert(!result.includes('<head>'))
  assert(!result.includes('<ttm:title>'))
  assert(!result.includes('<ttm:agent'))
  assert.equal(ttmlFilename(blank, 'audio-master'), 'audio-master.ttml')
})

test('Zvonko includes only the supplied title or artist', () => {
  const titleOnly = { ...options, title: ' Track ', artist: '' }
  const artistOnly = { ...options, title: '', artist: ' Artist ' }
  const titled = exportTtml(lines, titleOnly)
  assert(titled.includes('<ttm:title>Track</ttm:title>'))
  assert(!titled.includes('<ttm:agent'))
  const credited = exportTtml(lines, artistOnly)
  assert(credited.includes('<ttm:name type="full">Artist</ttm:name>'))
  assert(!credited.includes('<metadata>'))
  assert.equal(ttmlFilename(titleOnly, 'audio-master'), 'Track.ttml')
  assert.equal(ttmlFilename(artistOnly, 'audio-master'), 'Artist.ttml')
  assert.throws(() => exportTtml(lines, { ...titleOnly, title: 'bad\u0001' }))
})
test('rejects XML control characters and sanitizes filenames', () => {
  assert.throws(() => exportTtml([{ ...lines[0], text: 'bad\u0001' }], options))
  assert.equal(ttmlFilename({ ...options, title: 'a/b' }, 'demo'), 'a_b - артист.ttml')
})
