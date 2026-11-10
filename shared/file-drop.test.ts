import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyDroppedFiles, isFileDrag } from './file-drop.ts'

const audio = new File(['audio'], 'Mix.WAV')
const ogg = new File(['audio'], 'recording', { type: 'audio/ogg' })
const lrc = new File(['[00:01.123]Lyric'], 'Lyrics.LRC')
const ttml = new File(['<tt/>'], 'Lyrics.ttml', { type: 'application/xml' })
const image = new File(['image'], 'Cover.png', { type: 'image/png' })

test('accepts audio by extension or MIME type', () => {
  for (const file of [audio, ogg]) {
    assert.deepEqual(classifyDroppedFiles([file], false), { audio: file, lyrics: undefined })
  }
})

test('Lite routes mixed drops independently of their order', () => {
  for (const files of [[lrc, audio], [audio, ttml], [ttml]]) {
    const result = classifyDroppedFiles(files, true)
    assert.equal(result.audio, files.includes(audio) ? audio : undefined)
    assert.equal(result.lyrics, files.find(file => file !== audio))
  }
})

test('rejects unsupported and ambiguous drops without partial imports', () => {
  for (const [files, lite] of [
    [[audio, lrc], false], [[audio, ogg], true], [[lrc, ttml], true], [[audio, image], true],
  ] as const) {
    const result = classifyDroppedFiles(files, lite)
    assert(result.error)
    assert.equal(result.audio, undefined)
    assert.equal(result.lyrics, undefined)
  }
})

test('only file drags are intercepted', () => {
  assert(isFileDrag({ types: ['Files'] }))
  assert(!isFileDrag({ types: ['text/plain'] }))
})
