import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  FileAudio,
  FileText,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  TimerReset,
} from 'lucide-react'
import { exportTtml, formatLrcTime, ttmlFilename, validateTtml, type TtmlProfile } from '../../shared/ttml'
import './App.css'

type AppStep = 'in' | 'timing' | 'out'
type LyricsSource = 'paste' | 'recognize'
type SyncMode = 'manual' | 'auto'
type TimingMode = 'sync' | 'edit'
type TimingSource = 'empty' | 'manual' | 'auto' | 'edited'
type RecognitionLanguage = 'auto' | 'en' | 'ru'

type WordTiming = {
  text: string
  start: number
  end: number
}

type LyricLine = {
  id: string
  text: string
  start: number | null
  end: number | null
  source: TimingSource
  confidence?: number
  words?: WordTiming[]
}

type StartedLyricLine = LyricLine & { start: number }
type TimedLyricLine = LyricLine & { start: number; end: number }

type DraftWord = {
  token: string
  text: string
  start: number
  end: number
}

type LyricToken = {
  token: string
  lineIndex: number
}

type LineWordSpan = {
  first: number
  last: number
  matched: number
  tokenCount: number
  score: number
}

type HistoryEntry = {
  lineId: string
  previous: LyricLine
  next: LyricLine
}

type TranscribeResponse = {
  status?: string
  message?: string
  text?: string
  language?: string
  language_hint?: string
  lines?: unknown[]
}

const steps: AppStep[] = ['in', 'timing', 'out']

const stepLabels: Record<AppStep, string> = {
  in: 'In',
  timing: 'Match Timing & Edit',
  out: 'Out',
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

const formatClock = (seconds: number | null) => {
  if (seconds === null || Number.isNaN(seconds)) return '--:--.---'
  const total = Math.round(Math.max(0, seconds) * 1000)
  const minutes = Math.floor(total / 60000)
  const wholeSeconds = Math.floor(total / 1000) % 60
  const millis = total % 1000
  return `${pad(minutes)}:${pad(wholeSeconds)}.${pad(millis, 3)}`
}
const makeLines = (lyrics: string): LyricLine[] =>
  lyrics
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: `line-${index + 1}`,
      text,
      start: null,
      end: null,
      source: 'empty',
    }))

const normalizeToken = (value: string) =>
  value
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')

const lyricTokens = (value: string) =>
  value
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean)

const tokenDistance = (left: string, right: string) => {
  if (left === right) return 0
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index)
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let previous = rows[0]
    rows[0] = rightIndex
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const saved = rows[leftIndex]
      rows[leftIndex] = Math.min(
        rows[leftIndex] + 1,
        rows[leftIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      previous = saved
    }
  }
  return rows[left.length]
}

const tokenSimilarity = (target: string, draft: string) => {
  if (!target || !draft) return 0
  if (target === draft) return 1

  const longest = Math.max(target.length, draft.length)
  const shortest = Math.min(target.length, draft.length)
  if (longest < 5) return 0

  if (
    shortest >= 4 &&
    shortest / longest >= 0.72 &&
    (target.startsWith(draft) || draft.startsWith(target))
  ) {
    return 0.72
  }

  const distance = tokenDistance(target, draft)
  const maxDistance = longest >= 8 ? 2 : 1
  if (distance > maxDistance) return 0
  return Math.max(0, 1 - distance / longest)
}

const flattenDraftWords = (draftLines: LyricLine[]): DraftWord[] =>
  draftLines.flatMap((line) =>
    (line.words ?? [])
      .map((word) => ({
        token: normalizeToken(word.text),
        text: word.text,
        start: word.start,
        end: word.end,
      }))
      .filter(
        (word) =>
          word.token &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end) &&
          word.end >= word.start,
      ),
  )

const alignLyricsToDraftWords = (
  sourceLines: LyricLine[],
  draftWords: DraftWord[],
): Array<LineWordSpan | null> | null => {
  const sourceTokens: LyricToken[] = sourceLines.flatMap((line, lineIndex) =>
    lyricTokens(line.text).map((token) => ({ token, lineIndex })),
  )
  if (!sourceTokens.length || !draftWords.length) return null

  const rows = sourceTokens.length + 1
  const columns = draftWords.length + 1
  const cell = (row: number, column: number) => row * columns + column
  const scores = new Float32Array(rows * columns)
  const moves = new Uint8Array(rows * columns)
  const negative = -1_000_000

  scores.fill(negative)
  scores[0] = 0

  for (let row = 1; row < rows; row += 1) {
    scores[cell(row, 0)] = scores[cell(row - 1, 0)] - 1.15
    moves[cell(row, 0)] = 1
  }

  for (let column = 1; column < columns; column += 1) {
    scores[cell(0, column)] = scores[cell(0, column - 1)] - 0.35
    moves[cell(0, column)] = 2
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      let bestScore = scores[cell(row - 1, column)] - 1.15
      let bestMove = 1

      const skipDraftScore = scores[cell(row, column - 1)] - 0.35
      if (skipDraftScore > bestScore) {
        bestScore = skipDraftScore
        bestMove = 2
      }

      const similarity = tokenSimilarity(sourceTokens[row - 1].token, draftWords[column - 1].token)
      if (similarity > 0) {
        const matchScore = scores[cell(row - 1, column - 1)] + 2.8 * similarity
        if (matchScore > bestScore) {
          bestScore = matchScore
          bestMove = 3
        }
      }

      scores[cell(row, column)] = bestScore
      moves[cell(row, column)] = bestMove
    }
  }

  const spans = sourceLines.map<LineWordSpan | null>(() => null)
  let row = sourceTokens.length
  let column = draftWords.length

  while (row > 0 || column > 0) {
    const move = moves[cell(row, column)]
    if (move === 3 && row > 0 && column > 0) {
      const token = sourceTokens[row - 1]
      const wordIndex = column - 1
      const similarity = tokenSimilarity(token.token, draftWords[wordIndex].token)
      const current = spans[token.lineIndex]
      if (current) {
        current.first = Math.min(current.first, wordIndex)
        current.last = Math.max(current.last, wordIndex)
        current.matched += 1
        current.score += similarity
      } else {
        spans[token.lineIndex] = {
          first: wordIndex,
          last: wordIndex,
          matched: 1,
          tokenCount: lyricTokens(sourceLines[token.lineIndex].text).length,
          score: similarity,
        }
      }
      row -= 1
      column -= 1
    } else if (move === 1 && row > 0) {
      row -= 1
    } else if (column > 0) {
      column -= 1
    } else {
      row -= 1
    }
  }

  return spans.map((span) => {
    if (!span) return null
    const minMatches = span.tokenCount <= 3 ? span.tokenCount : Math.max(2, Math.ceil(span.tokenCount * 0.34))
    if (span.matched < minMatches) return null
    return span
  })
}

const compatibleDraftLine = (line: LyricLine, draft: LyricLine | undefined) => {
  if (!draft || draft.start === null || draft.end === null) return null
  const sourceTokens = new Set(lyricTokens(line.text))
  const draftTokens = lyricTokens(draft.text)
  if (!sourceTokens.size || !draftTokens.length) return null
  const shared = draftTokens.filter((token) => sourceTokens.has(token)).length
  return shared / Math.max(sourceTokens.size, draftTokens.length) >= 0.34 ? draft : null
}

const toNumberOrNull = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeTranscribedLines = (items: unknown[], fallbackText: string): LyricLine[] => {
  const lines = items
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (!text) return null
      const start = toNumberOrNull(record.start)
      const end = toNumberOrNull(record.end)
      const rawWords = Array.isArray(record.words) ? record.words : []
      const words = rawWords
        .map((word) => {
          if (!word || typeof word !== 'object') return null
          const wordRecord = word as Record<string, unknown>
          const wordText = typeof wordRecord.text === 'string' ? wordRecord.text.trim() : ''
          const wordStart = toNumberOrNull(wordRecord.start)
          const wordEnd = toNumberOrNull(wordRecord.end)
          if (!wordText || wordStart === null || wordEnd === null) return null
          return { text: wordText, start: wordStart, end: wordEnd }
        })
        .filter((word): word is WordTiming => word !== null)

      const line: LyricLine = {
        id: typeof record.id === 'string' ? record.id : `line-${index + 1}`,
        text,
        start,
        end,
        source: start !== null && end !== null ? 'auto' : 'empty',
        confidence: toNumberOrNull(record.confidence) ?? 0,
        words,
      }
      return line
    })
    .filter((line): line is LyricLine => line !== null)

  return lines.length ? lines : makeLines(fallbackText)
}

const applyDraftTiming = (lyrics: string, draftLines: LyricLine[]): LyricLine[] => {
  const sourceLines = makeLines(lyrics)
  if (!sourceLines.length) return draftLines

  const draftWords = flattenDraftWords(draftLines)
  if (draftWords.length) {
    const spans = alignLyricsToDraftWords(sourceLines, draftWords)
    return sourceLines.map((line, index) => {
      const span = spans?.[index]
      if (span) {
        const words = draftWords.slice(span.first, span.last + 1)
        return {
          ...line,
          start: words[0].start,
          end: words.at(-1)?.end ?? words[0].end,
          source: 'auto',
          confidence: Math.min(1, span.score / Math.max(1, span.tokenCount)),
          words: words.map((word) => ({
            text: word.text,
            start: word.start,
            end: word.end,
          })),
        }
      }

      const draft = compatibleDraftLine(line, draftLines[index])
      if (!draft) return line
      return {
        ...line,
        start: draft.start,
        end: draft.end,
        source: 'auto',
        confidence: draft.confidence ?? 0,
        words: draft.words,
      }
    })
  }

  return sourceLines.map((line, index) => {
    const draft = draftLines[index]
    if (!draft || draft.start === null || draft.end === null) return line
    return {
      ...line,
      start: draft.start,
      end: draft.end,
      source: 'auto',
      confidence: draft.confidence ?? 0,
      words: draft.words,
    }
  })
}

const isLyricLine = (line: unknown): line is LyricLine => {
  if (!line || typeof line !== 'object') return false
  const record = line as Record<string, unknown>
  const hasValidStart = record.start === null || Number.isFinite(record.start)
  const hasValidEnd = record.end === null || Number.isFinite(record.end)
  return typeof record.id === 'string' && typeof record.text === 'string' && hasValidStart && hasValidEnd
}

const hasLineStart = (line: unknown): line is StartedLyricLine =>
  isLyricLine(line) && line.start !== null

const hasLineTiming = (line: unknown): line is TimedLyricLine =>
  isLyricLine(line) && line.start !== null && line.end !== null

const exportLrc = (lines: LyricLine[]) =>
  lines
    .filter(hasLineStart)
    .map((line) => `[${formatLrcTime(line.start ?? 0)}]${line.text}`)
    .join('\n')



const exportProject = (lines: LyricLine[], audioName: string | null, mode: SyncMode) =>
  JSON.stringify(
    {
      app: 'Stars Clique Sync',
      version: 'v1',
      creator: {
        name: 'Stars Clique',
        telegram: 'https://t.me/starsclique',
      },
      license: 'Non-commercial redistribution only',
      mode,
      audio: { name: audioName },
      lines,
    },
    null,
    2,
  )

const downloadText = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function App() {
  const waveformRef = useRef<HTMLDivElement | null>(null)
  const waveRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const regionsUpdatingRef = useRef(false)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const startDraftRef = useRef<number | null>(null)
  const recordingPreviousRef = useRef<LyricLine | null>(null)
  const lineListRef = useRef<HTMLDivElement | null>(null)
  const lineRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const [step, setStep] = useState<AppStep>('in')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [audioName, setAudioName] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [lyricsSource, setLyricsSource] = useState<LyricsSource>('paste')
  const [lyricsText, setLyricsText] = useState('')
  const [recognizedLyricsText, setRecognizedLyricsText] = useState('')
  const [recognizedLines, setRecognizedLines] = useState<LyricLine[]>([])
  const [recognitionLanguage, setRecognitionLanguage] = useState<RecognitionLanguage>('auto')
  const [recognitionStatus, setRecognitionStatus] = useState('')
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [syncMode, setSyncMode] = useState<SyncMode>('manual')
  const [timingMode, setTimingMode] = useState<TimingMode>('sync')
  const [lines, setLines] = useState<LyricLine[]>([])
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [syncStart, setSyncStart] = useState<number | null>(null)
  const [ttmlProfile, setTtmlProfile] = useState<TtmlProfile>('zvonko')
  const [ttmlTitle, setTtmlTitle] = useState('')
  const [ttmlArtist, setTtmlArtist] = useState('')
  const [ttmlLanguage, setTtmlLanguage] = useState<'en-US' | 'ru-RU'>('en-US')

  const safeLines = useMemo(() => lines.filter(isLyricLine), [lines])
  const activeIndex = safeLines.findIndex((line) => line.id === activeLineId)
  const activeLine = activeIndex >= 0 ? safeLines[activeIndex] : null
  const timedLines = useMemo(() => safeLines.filter(hasLineTiming), [safeLines])
  const selectedLineSet = useMemo(() => new Set(selectedLineIds), [selectedLineIds])
  const selectedResetCount = useMemo(
    () =>
      safeLines.filter(
        (line) => selectedLineSet.has(line.id) && (line.start !== null || line.end !== null),
      ).length,
    [safeLines, selectedLineSet],
  )
  const playingLineId = useMemo(() => {
    if (step !== 'timing' || timingMode !== 'edit') return null
    return (
      timedLines.find((line) => currentTime >= line.start && currentTime <= line.end)?.id ?? null
    )
  }, [currentTime, step, timedLines, timingMode])

  const ttmlOptions = useMemo(() => ({
    duration, profile: ttmlProfile, title: ttmlTitle, artist: ttmlArtist, language: ttmlLanguage,
  }), [duration, ttmlProfile, ttmlTitle, ttmlArtist, ttmlLanguage])
  const ttmlIssues = useMemo(() => validateTtml(safeLines, ttmlOptions), [safeLines, ttmlOptions])

  const currentStepIndex = steps.indexOf(step)
  const hasPreparedProject = safeLines.length > 0
  const hasTimedLines = timedLines.length > 0
  const canContinueFromIn =
    Boolean(audioUrl) &&
    lyricsText.trim().length > 0
  const canOpenStep = useCallback(
    (target: AppStep) => {
      if (target === 'in') return true
      if (target === 'timing') return hasPreparedProject
      if (target === 'out') return hasPreparedProject && hasTimedLines
      return false
    },
    [hasPreparedProject, hasTimedLines],
  )

  useEffect(() => {
    if (!audioUrl || !waveformRef.current || step !== 'timing') return

    if (waveRef.current) {
      try {
        waveRef.current.destroy()
      } catch {
        // WaveSurfer can throw if React remounts the container during step changes.
      }
      waveRef.current = null
      regionsRef.current = null
    }
    const regions = RegionsPlugin.create()
    const wave = WaveSurfer.create({
      container: waveformRef.current,
      url: audioUrl,
      height: 'auto',
      barGap: 2,
      barRadius: 2,
      barWidth: 2,
      cursorColor: '#f4ebff',
      cursorWidth: 2,
      progressColor: '#a85eff',
      waveColor: '#28222f',
      plugins: [regions],
    })

    waveRef.current = wave
    regionsRef.current = regions
    wave.on('ready', () => setDuration(wave.getDuration()))
    wave.on('play', () => setIsPlaying(true))
    wave.on('pause', () => setIsPlaying(false))
    wave.on('finish', () => setIsPlaying(false))
    wave.on('timeupdate', (time) => setCurrentTime(time))
    wave.on('seeking', (time) => setCurrentTime(time))

    return () => {
      try {
        wave.destroy()
      } catch {
        // Ignore teardown races while switching between Sync and Edit.
      }
      waveRef.current = null
      regionsRef.current = null
    }
  }, [audioUrl, step])

  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !duration || step !== 'timing') return

    regionsUpdatingRef.current = true
    try {
      regions.clearRegions()

      if (timingMode === 'edit') {
        safeLines.forEach((line, index) => {
          if (
            line.start === null ||
            line.end === null ||
            !Number.isFinite(line.start) ||
            !Number.isFinite(line.end) ||
            line.end <= line.start
          ) return

          try {
            regions.addRegion({
              id: line.id,
              start: line.start,
              end: line.end,
              drag: true,
              resize: true,
              minLength: 0.05,
              color:
                line.id === activeLineId
                  ? 'rgba(168, 94, 255, 0.34)'
                  : index % 2 === 0
                    ? 'rgba(168, 94, 255, 0.18)'
                    : 'rgba(209, 199, 255, 0.14)',
              content: `${index + 1}`,
            })
          } catch (error) {
            console.warn('Skipping invalid waveform region:', line.id, error)
          }
        })
      }
    } catch (error) {
      console.warn('Could not rebuild waveform regions:', error)
    } finally {
      regionsUpdatingRef.current = false
    }

    const unsubs = [
      regions.on('region-clicked', (region: Region | undefined, event: MouseEvent) => {
        if (!region?.id) return
        event.stopPropagation()
        setActiveLineId(region.id)
      }),
      regions.on('region-updated', (region: Region | undefined) => {
        if (regionsUpdatingRef.current) return
        if (!region?.id) return
        if (!Number.isFinite(region.start) || !Number.isFinite(region.end) || region.end <= region.start) return
        setLines((current) =>
          current.map((line) =>
            line.id === region.id
              ? {
                  ...line,
                  start: Number(region.start.toFixed(3)),
                  end: Number(region.end.toFixed(3)),
                  source: 'edited',
                }
              : line,
          ),
        )
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [activeLineId, duration, safeLines, step, timingMode])

  useEffect(() => {
    if (step !== 'timing' || !activeLineId) return
    const list = lineListRef.current
    const activeRow = lineRowRefs.current.get(activeLineId)
    if (!list || !activeRow) return

    const frame = window.requestAnimationFrame(() => {
      const listRect = list.getBoundingClientRect()
      const activeRect = activeRow.getBoundingClientRect()
      list.scrollTo({
        top: list.scrollTop + activeRect.top - listRect.top - list.clientTop,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeLineId, step, timingMode])

  const transcribeAudio = useCallback(async () => {
    if (!audioFile) throw new Error('Choose audio first.')

    const form = new FormData()
    form.append('audio', audioFile)
    form.append('language', recognitionLanguage)
    const response = await fetch('http://127.0.0.1:8765/transcribe', {
      method: 'POST',
      body: form,
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(detail || `Backend returned ${response.status}`)
    }

    const data = await response.json() as TranscribeResponse
    const nextLines = normalizeTranscribedLines(data.lines ?? [], data.text ?? '')
    const nextText = data.text ?? nextLines.map((line) => line.text).join('\n')
    if (!nextText.trim()) {
      throw new Error(data.message || 'Whisper did not find lyrics in this audio.')
    }

    return { data, lines: nextLines, text: nextText }
  }, [audioFile, recognitionLanguage])

  const prepareProject = useCallback(async () => {
    if (isPreparing) return

    setIsPreparing(true)
    setRecognitionStatus(syncMode === 'auto' ? 'Creating auto timing draft...' : '')

    try {
      const shouldKeepRecognizedTimings =
        recognizedLines.length > 0 &&
        recognizedLyricsText.trim().length > 0 &&
        lyricsText.trim() === recognizedLyricsText.trim()

      let nextLines: LyricLine[]
      if (syncMode === 'auto') {
        const draft = shouldKeepRecognizedTimings
          ? { lines: recognizedLines, text: recognizedLyricsText }
          : await transcribeAudio()
        nextLines = lyricsText.trim() === draft.text.trim()
          ? draft.lines
          : applyDraftTiming(lyricsText, draft.lines)
      } else {
        nextLines = makeLines(lyricsText)
      }

      if (!nextLines.length) {
        setRecognitionStatus('Recognize or paste lyrics first, then continue.')
        return
      }

      setLines(nextLines)
      setActiveLineId(nextLines[0]?.id ?? null)
      setSelectedLineIds(nextLines[0]?.id ? [nextLines[0].id] : [])
      setSelectionAnchorId(nextLines[0]?.id ?? null)
      setHistory([])
      setTimingMode(syncMode === 'auto' ? 'edit' : 'sync')
      setStep('timing')
      setRecognitionStatus(
        syncMode === 'auto'
          ? `Auto draft created: ${nextLines.filter((line) => line.start !== null && line.end !== null).length} timed lines.`
          : '',
      )
    } catch (error) {
      setRecognitionStatus(
        error instanceof Error ? `Auto sync failed: ${error.message}` : 'Auto sync failed.',
      )
    } finally {
      setIsPreparing(false)
    }
  }, [
    isPreparing,
    lyricsText,
    recognizedLines,
    recognizedLyricsText,
    syncMode,
    transcribeAudio,
  ])

  const patchLine = useCallback((lineId: string, patch: Partial<LyricLine>) => {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    )
  }, [])

  const selectLine = useCallback(
    (lineId: string, event?: ReactMouseEvent) => {
      setActiveLineId(lineId)
      setSyncStart(null)
      startDraftRef.current = null

      if (event?.shiftKey && selectionAnchorId) {
        const anchorIndex = safeLines.findIndex((line) => line.id === selectionAnchorId)
        const nextIndex = safeLines.findIndex((line) => line.id === lineId)
        if (anchorIndex >= 0 && nextIndex >= 0) {
          const [from, to] =
            anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex]
          setSelectedLineIds(safeLines.slice(from, to + 1).map((line) => line.id))
          return
        }
      }

      if (event?.ctrlKey || event?.metaKey) {
        setSelectedLineIds((current) =>
          current.includes(lineId)
            ? current.filter((selectedId) => selectedId !== lineId)
            : [...current, lineId],
        )
        setSelectionAnchorId(lineId)
        return
      }

      setSelectedLineIds([lineId])
      setSelectionAnchorId(lineId)
    },
    [safeLines, selectionAnchorId],
  )

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (!safeLines.length) return
      const nextIndex =
        activeIndex < 0 ? 0 : Math.min(safeLines.length - 1, Math.max(0, activeIndex + direction))
      selectLine(safeLines[nextIndex].id)
    },
    [activeIndex, safeLines, selectLine],
  )

  const undoLastLine = useCallback(() => {
    setHistory((stack) => {
      const last = stack.at(-1)
      if (!last) return stack
      setLines((current) =>
        current.map((line) => (line.id === last.lineId ? last.previous : line)),
      )
      setActiveLineId(last.lineId)
      return stack.slice(0, -1)
    })
    setSyncStart(null)
    startDraftRef.current = null
  }, [])

  const enterEditMode = useCallback(() => {
    waveRef.current?.pause()
    startDraftRef.current = null
    recordingPreviousRef.current = null
    setSyncStart(null)
    window.requestAnimationFrame(() => {
      setTimingMode('edit')
    })
  }, [])

  const enterMatchTimingMode = useCallback(() => {
    waveRef.current?.pause()
    startDraftRef.current = null
    recordingPreviousRef.current = null
    setSyncStart(null)
    setSyncMode('manual')
    setTimingMode('sync')

    const targetLine = activeLine ?? safeLines[0]
    if (!activeLineId && targetLine) {
      setActiveLineId(targetLine.id)
      setSelectedLineIds([targetLine.id])
      setSelectionAnchorId(targetLine.id)
    }
    if (targetLine?.start !== null && targetLine?.start !== undefined && duration) {
      waveRef.current?.seekTo(Math.min(1, targetLine.start / duration))
    }
  }, [activeLine, activeLineId, duration, safeLines])

  const resetSelectedTimings = useCallback(() => {
    const fallbackIds = activeLineId ? [activeLineId] : []
    const targetIds = selectedLineIds.length ? selectedLineIds : fallbackIds
    if (!targetIds.length) return

    const targetSet = new Set(targetIds)
    setLines((current) =>
      current.map((line) =>
        targetSet.has(line.id)
          ? {
              ...line,
              start: null,
              end: null,
              source: 'empty',
              confidence: undefined,
              words: undefined,
            }
          : line,
      ),
    )
    setHistory((current) => current.filter((entry) => !targetSet.has(entry.lineId)))
    setSyncStart(null)
    startDraftRef.current = null
    recordingPreviousRef.current = null
  }, [activeLineId, selectedLineIds])

  const resetProject = useCallback(() => {
    waveRef.current?.pause()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    if (audioInputRef.current) audioInputRef.current.value = ''
    startDraftRef.current = null
    recordingPreviousRef.current = null
    setStep('in')
    setAudioFile(null)
    setAudioName(null)
    setTtmlTitle('')
    setTtmlArtist('')
    setAudioUrl(null)
    setTtmlProfile('zvonko')
    setLyricsSource('paste')
    setLyricsText('')
    setRecognizedLyricsText('')
    setRecognizedLines([])
    setRecognitionStatus('')
    setIsRecognizing(false)
    setIsPreparing(false)
    setSyncMode('manual')
    setTimingMode('sync')
    setLines([])
    setActiveLineId(null)
    setSelectedLineIds([])
    setSelectionAnchorId(null)
    setHistory([])
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)
    setSyncStart(null)
  }, [audioUrl])

  const handleSpaceDown = useCallback(() => {
    if (step !== 'timing') return
    if (timingMode !== 'sync') return
    if (!activeLine || startDraftRef.current !== null) return
    const time = waveRef.current?.getCurrentTime() ?? currentTime
    startDraftRef.current = time
    recordingPreviousRef.current = activeLine
    setSyncStart(time)
    patchLine(activeLine.id, {
      start: time,
      end: null,
      source: 'manual',
    })
  }, [activeLine, currentTime, patchLine, step, timingMode])

  const handleSpaceUp = useCallback(() => {
    if (step !== 'timing') return
    if (timingMode !== 'sync') return
    if (!activeLine || startDraftRef.current === null) return
    const end = Math.max(waveRef.current?.getCurrentTime() ?? currentTime, startDraftRef.current + 0.05)
    const previous = recordingPreviousRef.current ?? activeLine
    const next: LyricLine = {
      ...activeLine,
      start: startDraftRef.current,
      end,
      source: 'manual',
    }

    setLines((current) => current.map((line) => (line.id === activeLine.id ? next : line)))
    setHistory((stack) => [...stack, { lineId: activeLine.id, previous, next }])
    startDraftRef.current = null
    recordingPreviousRef.current = null
    setSyncStart(null)

    if (activeIndex >= 0 && activeIndex < safeLines.length - 1) {
      const nextLineId = safeLines[activeIndex + 1].id
      setActiveLineId(nextLineId)
      setSelectedLineIds([nextLineId])
      setSelectionAnchorId(nextLineId)
    } else {
      setActiveLineId(activeLine.id)
      setSelectedLineIds([activeLine.id])
      setSelectionAnchorId(activeLine.id)
      enterEditMode()
    }
  }, [activeIndex, activeLine, currentTime, enterEditMode, safeLines, step, timingMode])

  const togglePlay = useCallback(() => {
    waveRef.current?.playPause()
  }, [])

  const seekToLine = useCallback(
    (line: LyricLine) => {
      if (line.start === null || !duration) return
      waveRef.current?.seekTo(Math.min(1, line.start / duration))
    },
    [duration],
  )

  const playActiveLine = useCallback(() => {
    if (!activeLine || activeLine.start === null || !waveRef.current || !duration) return
    seekToLine(activeLine)
    waveRef.current.play()
    if (activeLine.end !== null) {
      window.setTimeout(() => {
        const now = waveRef.current?.getCurrentTime() ?? 0
        if (activeLine.end !== null && now >= activeLine.end - 0.08) waveRef.current?.pause()
      }, Math.max(80, (activeLine.end - activeLine.start) * 1000))
    }
  }, [activeLine, duration, seekToLine])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) handleSpaceDown()
      }
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault()
        undoLastLine()
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(1)
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(-1)
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        playActiveLine()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        handleSpaceUp()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  })

  const onAudioChange = (file: File | null) => {
    if (!file) return
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioFile(file)
    setAudioName(file.name)
    setTtmlTitle(file.name.replace(/\.[^.]+$/, ''))
    setTtmlArtist('')
    setAudioUrl(URL.createObjectURL(file))
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)
    setRecognizedLyricsText('')
    setRecognizedLines([])
    setTimingMode('sync')
    setSelectedLineIds([])
    setSelectionAnchorId(null)
  }

  const recognizeFromAudio = async () => {
    if (!audioFile) {
      setRecognitionStatus('Choose audio first.')
      return
    }

    setIsRecognizing(true)
    setRecognitionStatus('Recognizing lyrics...')

    try {
      const { data, lines: nextLines, text: nextText } = await transcribeAudio()
      setLyricsText(nextText)
      setRecognizedLyricsText(nextText)
      setRecognizedLines(nextLines)
      setLines([])
      setActiveLineId(null)
      setSelectedLineIds([])
      setSelectionAnchorId(null)
      setHistory([])
      setLyricsSource('paste')
      setRecognitionStatus(
        `Recognized ${nextLines.length} phrases${data.language ? ` (${data.language})` : ''}.`,
      )
    } catch (error) {
      setRecognitionStatus(
        error instanceof Error
          ? `Recognition failed: ${error.message}`
          : 'Recognition failed.',
      )
    } finally {
      setIsRecognizing(false)
    }
  }

  const goToStep = (nextStep: AppStep) => {
    waveRef.current?.pause()
    if (canOpenStep(nextStep)) setStep(nextStep)
  }

  const onTimeEdit = (lineId: string, field: 'start' | 'end', value: string) => {
    const parsed = value.trim() ? Number(value) : NaN
    patchLine(lineId, {
      [field]: Number.isFinite(parsed) ? parsed : null,
      source: 'edited',
    })
  }

  const onTextEdit = (lineId: string, value: string) => {
    patchLine(lineId, {
      text: value,
      source: 'edited',
    })
  }

  const deleteLine = (lineId: string) => {
    setLines((current) => {
      const next = current.filter((line) => line.id !== lineId)
      if (activeLineId === lineId) {
        const deletedIndex = current.findIndex((line) => line.id === lineId)
        const fallback = next[Math.min(Math.max(0, deletedIndex), Math.max(0, next.length - 1))]
        setActiveLineId(fallback?.id ?? null)
        setSelectedLineIds(fallback?.id ? [fallback.id] : [])
        setSelectionAnchorId(fallback?.id ?? null)
      }
      return next
    })
    setSelectedLineIds((current) => current.filter((selectedId) => selectedId !== lineId))
    setSelectionAnchorId((current) => (current === lineId ? null : current))
    setHistory((current) => current.filter((entry) => entry.lineId !== lineId))
  }

  const saveAndOpenOut = () => {
    waveRef.current?.pause()
    setLines((current) => current.filter((line) => line.text.trim()))
    if (hasTimedLines) setStep('out')
  }

  const exportFile = (format: 'ttml' | 'lrc' | 'json') => {
    const base = (audioName ?? 'stars-clique-sync').replace(/\.[^.]+$/, '')
    if (format === 'ttml') {
      if (ttmlIssues.length) return
      downloadText(ttmlFilename(ttmlOptions, base), exportTtml(safeLines, ttmlOptions))
    }
    if (format === 'lrc') downloadText(`${base}.lrc`, exportLrc(safeLines))
    if (format === 'json') downloadText(`${base}.scsync.json`, exportProject(safeLines, audioName, syncMode))
  }

  const reviewExportLine = (number: number) => {
    const line = safeLines[number - 1]
    if (!line) return
    waveRef.current?.pause()
    setActiveLineId(line.id)
    setSelectedLineIds([line.id])
    setSelectionAnchorId(line.id)
    setTimingMode('edit')
    setStep('timing')
  }

  const renderStepNav = () => (
    <nav className="step-nav" aria-label="Workflow">
      {steps.map((item, index) => (
        <button
          key={item}
          type="button"
          className={item === step ? 'active' : index < currentStepIndex ? 'done' : ''}
          disabled={!canOpenStep(item)}
          onClick={() => {
            goToStep(item)
          }}
        >
          <span>{index + 1}</span>
          {stepLabels[item]}
        </button>
      ))}
    </nav>
  )

  const renderWaveform = () => (
    <section className="surface waveform-surface">
      <div className="wave-top">
        <span>{audioName ?? 'No audio'}</span>
        <strong>
          {formatClock(currentTime)} / {formatClock(duration)}
        </strong>
      </div>
      <div ref={waveformRef} className="waveform" />
      {!audioUrl && <div className="wave-empty">Choose audio on In step</div>}
    </section>
  )

  const renderLineList = (compact = false) => (
    <div
      ref={lineListRef}
      className={`${compact ? 'line-list compact' : 'line-list'} ${
        timingMode === 'edit' && !compact ? 'editing' : ''
      }`}
    >
      {safeLines.map((line, index) => (
        <div
          key={line.id}
          ref={(node) => {
            if (node) lineRowRefs.current.set(line.id, node)
            else lineRowRefs.current.delete(line.id)
          }}
          className={`line-row ${line.id === activeLineId ? 'active' : ''} ${
            line.id === playingLineId ? 'playing' : ''
          } ${selectedLineSet.has(line.id) ? 'selected' : ''} ${
            line.start !== null && line.end !== null && index < activeIndex ? 'synced' : ''
          }`}
          onClick={(event) => selectLine(line.id, event)}
          onDoubleClick={() => seekToLine(line)}
        >
          <span className="line-number">{pad(index + 1)}</span>
          {timingMode === 'edit' && !compact ? (
            <input
              className="line-text-input"
              value={line.text}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onTextEdit(line.id, event.target.value)}
            />
          ) : (
            <span className="line-text">{line.text}</span>
          )}
          {!compact && (
            <>
              <label>
                Start
                <input
                  type="number"
                  step="0.001"
                  value={line.start ?? ''}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => onTimeEdit(line.id, 'start', event.target.value)}
                />
              </label>
              <label>
                End
                <input
                  type="number"
                  step="0.001"
                  value={line.end ?? ''}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => onTimeEdit(line.id, 'end', event.target.value)}
                />
              </label>
            </>
          )}
          <span className="time-range">{formatClock(line.start)} - {formatClock(line.end)}</span>
          {timingMode === 'edit' && !compact && (
            <button
              type="button"
              className="danger-action"
              onClick={(event) => {
                event.stopPropagation()
                deleteLine(line.id)
              }}
            >
              Delete
            </button>
          )}
        </div>
      ))}
      {!safeLines.length && <div className="empty-state">No lines prepared yet.</div>}
    </div>
  )

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p>Stars Clique Sync <span>v1</span></p>
          <h1>{stepLabels[step]}</h1>
        </div>
        <div className="header-actions">
          {renderStepNav()}
          <button type="button" className="reset-project-action" onClick={resetProject}>
            <RotateCw size={16} />
            Reset project
          </button>
        </div>
      </header>

      {step === 'in' && (
        <section className="screen in-screen">
          <div className="surface intro-copy">
            <h2>Start a sync project</h2>
            <p>Load audio, choose where lyrics come from, then pick auto or manual timing.</p>
          </div>

          <div className="surface input-card">
            <div className="field-head">
              <FileAudio size={18} />
              <span>Audio</span>
            </div>
            <label className="file-input">
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                onChange={(event) => onAudioChange(event.target.files?.[0] ?? null)}
              />
              <strong>{audioName ?? 'Choose audio file'}</strong>
            </label>
          </div>

          <div className="surface input-card">
            <div className="field-head">
              <FileText size={18} />
              <span>Lyrics</span>
            </div>
            <div className="segmented">
              <button type="button" className={lyricsSource === 'paste' ? 'active' : ''} onClick={() => setLyricsSource('paste')}>
                I have lyrics
              </button>
              <button
                type="button"
                className={lyricsSource === 'recognize' ? 'active' : ''}
                disabled={!audioFile || isRecognizing}
                onClick={recognizeFromAudio}
              >
                <Sparkles size={14} />
                Recognize from audio
              </button>
            </div>
            <label className="language-select">
              <span>Language hint</span>
              <select
                value={recognitionLanguage}
                onChange={(event) => setRecognitionLanguage(event.target.value as RecognitionLanguage)}
                disabled={isRecognizing}
              >
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="ru">Russian</option>
              </select>
            </label>
            <textarea
              value={lyricsText}
              placeholder="Paste lyrics here or recognize them from audio"
              onChange={(event) => setLyricsText(event.target.value)}
            />
            <div className="recognize-note inline">
              <Sparkles size={18} />
              <span>
                {recognitionStatus || 'Recognize fills this lyrics field. You can edit the result before continuing.'}
              </span>
            </div>
          </div>

          <div className="surface input-card">
            <div className="field-head">
              <Sparkles size={18} />
              <span>Mode</span>
            </div>
            <div className="choice-grid">
              <button type="button" className={syncMode === 'auto' ? 'choice active' : 'choice'} onClick={() => setSyncMode('auto')}>
                <strong>Auto</strong>
                <span>Create a timing draft, then edit it.</span>
              </button>
              <button type="button" className={syncMode === 'manual' ? 'choice active' : 'choice'} onClick={() => setSyncMode('manual')}>
                <strong>Manual</strong>
                <span>Hold Space line by line.</span>
              </button>
            </div>
          </div>

          <button type="button" className="continue-btn" disabled={!canContinueFromIn || isPreparing} onClick={prepareProject}>
            {isPreparing ? 'Preparing...' : 'Continue'}
            <ArrowRight size={18} />
          </button>
        </section>
      )}

      {step === 'timing' && (
        <section className="screen sync-screen">
          {renderWaveform()}

          {syncMode === 'manual' ? (
            <div className="surface sync-card">
              <div className="sync-focus">
                <span>{timingMode === 'sync' ? 'Selected line' : 'Edit synced lines'}</span>
                <strong>{timingMode === 'sync' ? activeLine?.text ?? 'No line selected' : 'Review, rewrite, delete, then save'}</strong>
                {timingMode === 'sync' && (
                  <em className="sync-recording">{syncStart !== null ? `Recording from ${formatClock(syncStart)}` : null}</em>
                )}
              </div>
              <div className="transport">
                <button type="button" onClick={togglePlay} className="primary-action">
                  {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button type="button" onClick={undoLastLine} disabled={!history.length || timingMode !== 'sync'}>
                  <RotateCcw size={17} />
                  Undo
                </button>
                {timingMode === 'sync' ? (
                  <button type="button" disabled={!hasTimedLines} onClick={enterEditMode}>
                    Edit
                    <ArrowRight size={17} />
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={enterMatchTimingMode}>
                      <TimerReset size={17} />
                      Match timing
                    </button>
                    <button type="button" disabled={!selectedResetCount} onClick={resetSelectedTimings}>
                      <RotateCcw size={17} />
                      Reset timing
                    </button>
                    <button type="button" disabled={!hasTimedLines} onClick={saveAndOpenOut}>
                      Save
                      <ArrowRight size={17} />
                    </button>
                  </>
                )}
              </div>
              {timingMode === 'sync' ? (
                <div className="shortcut-row">
                  <span><kbd>Space</kbd> hold</span>
                  <span><kbd>Esc</kbd> undo</span>
                  <span><kbd>Up/Down</kbd> select</span>
                  <span><kbd>Enter</kbd> replay</span>
                </div>
              ) : (
                <div className="shortcut-row">
                  <span>{selectedLineIds.length} selected</span>
                  <span><kbd>Shift</kbd> range select</span>
                  <span><kbd>Ctrl</kbd> multi select</span>
                  <span><kbd>Enter</kbd> replay selected line</span>
                </div>
              )}
            </div>
          ) : (
            <div className="surface sync-card">
              <div className="sync-focus">
                <span>Auto Sync</span>
                <strong>Draft timing is ready to edit</strong>
                <em>Adjust words, delete rows, or move markers before saving.</em>
              </div>
              <div className="transport">
                <button type="button" onClick={togglePlay} className="primary-action">
                  {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSyncMode('manual')
                    setTimingMode('sync')
                  }}
                >
                  Manual instead
                </button>
                <button type="button" onClick={enterMatchTimingMode}>
                  <TimerReset size={17} />
                  Match timing
                </button>
                <button type="button" disabled={!selectedResetCount} onClick={resetSelectedTimings}>
                  <RotateCcw size={17} />
                  Reset timing
                </button>
                <button type="button" disabled={!hasTimedLines} onClick={saveAndOpenOut}>
                  Save
                  <ArrowRight size={17} />
                </button>
              </div>
            </div>
          )}

          <div className="surface edit-toolbar">
            <button type="button" onClick={() => goToStep('in')}>
              <ArrowLeft size={17} />
              In
            </button>
            <button type="button" onClick={playActiveLine}>Replay line</button>
            <button type="button" disabled={!selectedResetCount} onClick={resetSelectedTimings}>
              <RotateCcw size={17} />
              Reset timing
            </button>
            {timingMode === 'sync' && syncMode === 'manual' ? (
              <button type="button" disabled={!hasTimedLines} onClick={enterEditMode}>
                Edit
                <ArrowRight size={17} />
              </button>
            ) : (
              <>
                <button type="button" onClick={enterMatchTimingMode}>
                  <TimerReset size={17} />
                  Match timing
                </button>
                <button type="button" disabled={!hasTimedLines} onClick={saveAndOpenOut}>
                  Save
                  <ArrowRight size={17} />
                </button>
              </>
            )}
          </div>

          <div className="surface">
            {renderLineList()}
          </div>
        </section>
      )}

      {step === 'out' && (
        <section className="screen export-screen">
          <div className="surface export-summary">
            <h2>{ttmlIssues.length ? 'Review export' : 'Ready to export'}</h2>
            <p>{timedLines.length} of {safeLines.length} lines timed.</p>
            <p>{ttmlIssues.length ? 'TTML needs review.' : <><Check size={16} /> TTML checks passed.</>}</p>
          </div>

          <section className="surface ttml-options" aria-label="TTML export settings">
            <label>
              TTML profile
              <select value={ttmlProfile} onChange={(event) => setTtmlProfile(event.target.value as TtmlProfile)}>
                <option value="standard">Standard TTML</option>
                <option value="zvonko">Zvonko TTML</option>
              </select>
            </label>
            {ttmlProfile === 'zvonko' && (
              <div className="ttml-metadata">
                <label>Track title<input placeholder="Optional" value={ttmlTitle} onChange={(event) => setTtmlTitle(event.target.value)} /></label>
                <label>Artist<input placeholder="Optional" value={ttmlArtist} onChange={(event) => setTtmlArtist(event.target.value)} /></label>
                <label>
                  Lyrics language
                  <select value={ttmlLanguage} onChange={(event) => setTtmlLanguage(event.target.value as 'en-US' | 'ru-RU')}>
                    <option value="en-US">English (Zvonko default)</option>
                    <option value="ru-RU">Russian</option>
                  </select>
                </label>
              </div>
            )}
          </section>
          {ttmlIssues.length > 0 && (
            <section className="surface ttml-checks" aria-label="TTML checks">
              <h2>Resolve before TTML export</h2>
              <ul>
                {ttmlIssues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    {issue.line !== null && <button type="button" onClick={() => reviewExportLine(issue.line!)}>Line {issue.line}</button>}
                    <span><strong>{issue.code}</strong> · {issue.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}


          <div className="export-actions">
            <button type="button" disabled={ttmlIssues.length > 0} onClick={() => exportFile('ttml')}>
              <Download size={18} />
              TTML
            </button>
            <button type="button" onClick={() => exportFile('lrc')}>
              <Download size={18} />
              LRC
            </button>
            <button type="button" onClick={() => exportFile('json')}>
              <Download size={18} />
              Project JSON
            </button>
          </div>
        </section>
      )}

      <footer className="app-footer">
        <span>Stars Clique</span>
        <span>Developed by Mikhail Mikhalchenko (Goth Angel)</span>
        <span>Non-commercial redistribution only</span>
        <a href="https://t.me/starsclique" target="_blank" rel="noreferrer">
          Telegram
        </a>
      </footer>
    </main>
  )
}

export default App
