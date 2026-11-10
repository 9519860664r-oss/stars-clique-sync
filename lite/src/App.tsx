import { type DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import {
  ArrowRight,
  Check,
  Download,
  FileAudio,
  FileText,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react'
import { classifyDroppedFiles, isFileDrag, preventFileNavigation } from '../../shared/file-drop'
import { exportTtml, formatLrcTime, ttmlFilename, validateTtml } from '../../shared/ttml'
import './App.css'

type AppStep = 'in' | 'timing' | 'out'
type TimingMode = 'sync' | 'edit'
type TimingSource = 'empty' | 'manual' | 'edited' | 'imported'

type LyricLine = {
  id: string
  text: string
  start: number | null
  end: number | null
  source: TimingSource
}

type TimedLyricLine = LyricLine & { start: number; end: number }

type HistoryEntry = {
  lineId: string
  previous: LyricLine
  next: LyricLine
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

const textLines = (lyrics: string) =>
  lyrics
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)

const parseTimingValue = (value: string) => {
  const clean = value.trim().replace(',', '.')
  if (!clean) return null
  if (clean.endsWith('ms')) {
    const millis = Number(clean.slice(0, -2))
    return Number.isFinite(millis) ? millis / 1000 : null
  }
  if (clean.endsWith('s')) {
    const seconds = Number(clean.slice(0, -1))
    return Number.isFinite(seconds) ? seconds : null
  }

  const parts = clean.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return null
}

const textFromElement = (element: Element) =>
  Array.from(element.childNodes)
    .map((node) => node.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeImportedEnds = (lines: LyricLine[]) =>
  lines.map((line, index) => {
    if (line.start === null) return line
    const nextStart = lines[index + 1]?.start
    const fallbackEnd =
      typeof nextStart === 'number' && nextStart > line.start
        ? Math.max(line.start + 0.05, nextStart - 0.01)
        : line.start + 2

    return {
      ...line,
      end: line.end !== null && line.end > line.start ? line.end : Number(fallbackEnd.toFixed(3)),
    }
  })

const parseLrc = (content: string): LyricLine[] => {
  const parsed: LyricLine[] = []

  content.split(/\r?\n/).forEach((rawLine) => {
    const timeMatches = [...rawLine.matchAll(/\[((?:\d{1,3}:)?\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!timeMatches.length) return

    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim()
    if (!text) return

    timeMatches.forEach((match) => {
      const start = parseTimingValue(match[1].replace(/(\d+:\d+)\.(\d+)$/, '$1.$2'))
      if (start === null) return
      parsed.push({
        id: `line-${parsed.length + 1}`,
        text,
        start,
        end: null,
        source: 'imported',
      })
    })
  })

  return normalizeImportedEnds(parsed.sort((left, right) => (left.start ?? 0) - (right.start ?? 0)))
}

const parseTtml = (content: string): LyricLine[] => {
  const doc = new DOMParser().parseFromString(content, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('TTML XML is not valid.')
  }

  const paragraphElements = Array.from(doc.getElementsByTagNameNS('*', 'p'))
  const parsed = (paragraphElements.length ? paragraphElements : Array.from(doc.getElementsByTagName('p')))
    .map((element, index): LyricLine | null => {
      const begin = element.getAttribute('begin')
      const end = element.getAttribute('end')
      const start = begin ? parseTimingValue(begin) : null
      const finish = end ? parseTimingValue(end) : null
      const text = textFromElement(element)
      if (!text || start === null) return null
      return {
        id: `line-${index + 1}`,
        text,
        start,
        end: finish,
        source: 'imported' as const,
      }
    })
    .filter((line): line is LyricLine => line !== null)

  return normalizeImportedEnds(parsed)
}

const parseTimedLyrics = (fileName: string, content: string) => {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.lrc')) return parseLrc(content)
  if (lower.endsWith('.ttml') || lower.endsWith('.xml')) return parseTtml(content)
  if (content.trim().startsWith('<')) return parseTtml(content)
  return parseLrc(content)
}

const applyImportedTimings = (lyrics: string, timingLines: LyricLine[]) => {
  const sourceTexts = textLines(lyrics)
  return sourceTexts.map((text, index) => {
    const timing = timingLines[index]
    return {
      id: `line-${index + 1}`,
      text,
      start: timing?.start ?? null,
      end: timing?.end ?? null,
      source:
        typeof timing?.start === 'number' && typeof timing?.end === 'number' ? 'imported' : 'empty',
    } satisfies LyricLine
  })
}

const isLyricLine = (line: unknown): line is LyricLine => {
  if (!line || typeof line !== 'object') return false
  const record = line as Record<string, unknown>
  const hasValidStart = record.start === null || Number.isFinite(record.start)
  const hasValidEnd = record.end === null || Number.isFinite(record.end)
  return typeof record.id === 'string' && typeof record.text === 'string' && hasValidStart && hasValidEnd
}

const hasLineTiming = (line: unknown): line is TimedLyricLine =>
  isLyricLine(line) && line.start !== null && line.end !== null

const exportLrc = (lines: LyricLine[]) =>
  lines
    .filter(hasLineTiming)
    .map((line) => `[${formatLrcTime(line.start)}]${line.text}`)
    .join('\n')



const exportProject = (lines: LyricLine[], audioName: string | null) =>
  JSON.stringify(
    {
      app: 'Stars Clique Sync Lite',
      version: 'v1-lite',
      mode: 'manual',
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
  const startDraftRef = useRef<number | null>(null)
  const recordingPreviousRef = useRef<LyricLine | null>(null)
  const lineListRef = useRef<HTMLDivElement | null>(null)
  const lineRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const lineCursorRefs = useRef<Map<string, number>>(new Map())

  const [step, setStep] = useState<AppStep>('in')
  const [audioName, setAudioName] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [lyricsText, setLyricsText] = useState('')
  const [importedLyricsText, setImportedLyricsText] = useState('')
  const [importedLines, setImportedLines] = useState<LyricLine[]>([])
  const [importedFileName, setImportedFileName] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [timingMode, setTimingMode] = useState<TimingMode>('sync')
  const [lines, setLines] = useState<LyricLine[]>([])
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [syncStart, setSyncStart] = useState<number | null>(null)
  const [ttmlTitle, setTtmlTitle] = useState('')
  const [ttmlSubtitle, setTtmlSubtitle] = useState('')
  const [ttmlArtist, setTtmlArtist] = useState('')
  const [isFileOver, setIsFileOver] = useState(false)
  const [fileDropError, setFileDropError] = useState('')

  useEffect(preventFileNavigation, [])

  const safeLines = useMemo(() => lines.filter(isLyricLine), [lines])
  const activeIndex = safeLines.findIndex((line) => line.id === activeLineId)
  const activeLine = activeIndex >= 0 ? safeLines[activeIndex] : null
  const timedLines = useMemo(() => safeLines.filter(hasLineTiming), [safeLines])
  const playingLineId = useMemo(() => {
    if (step !== 'timing' || timingMode !== 'edit') return null
    return timedLines.find((line) => currentTime >= line.start && currentTime <= line.end)?.id ?? null
  }, [currentTime, step, timedLines, timingMode])

  const ttmlOptions = useMemo(() => ({
    duration, title: ttmlTitle, subtitle: ttmlSubtitle, artist: ttmlArtist,
  }), [duration, ttmlTitle, ttmlSubtitle, ttmlArtist])
  const ttmlIssues = useMemo(() => validateTtml(safeLines, ttmlOptions), [safeLines, ttmlOptions])

  const currentStepIndex = steps.indexOf(step)
  const hasPreparedProject = safeLines.length > 0
  const hasTimedLines = timedLines.length > 0
  const canContinueFromIn = Boolean(audioUrl) && lyricsText.trim().length > 0

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
        // Ignore teardown races while switching steps.
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
        // Ignore teardown races while switching steps.
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
          if (!hasLineTiming(line) || line.end <= line.start) return
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
        if (regionsUpdatingRef.current || !region?.id) return
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

  const prepareProject = useCallback(() => {
    const hasImportedTiming = importedLines.some((line) => line.start !== null || line.end !== null)
    const nextLines = hasImportedTiming ? applyImportedTimings(lyricsText, importedLines) : makeLines(lyricsText)
    if (!nextLines.length) {
      setStatus('Paste lyrics first, then continue.')
      return
    }

    setLines(nextLines)
    setActiveLineId(nextLines[0]?.id ?? null)
    setHistory([])
    setTimingMode(hasImportedTiming ? 'edit' : 'sync')
    setStep('timing')
    setStatus('')
  }, [importedLines, lyricsText])

  const patchLine = useCallback((lineId: string, patch: Partial<LyricLine>) => {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    )
  }, [])

  const seekToTime = useCallback(
    (time: number) => {
      const wave = waveRef.current
      const waveDuration = duration || wave?.getDuration() || 0
      const safeTime = Math.max(0, Math.min(time, waveDuration || time))
      if (wave && waveDuration) {
        wave.seekTo(Math.min(1, safeTime / waveDuration))
      }
      setCurrentTime(safeTime)
    },
    [duration],
  )

  const selectLine = useCallback(
    (lineId: string) => {
      setActiveLineId(lineId)
      setSyncStart(null)
      startDraftRef.current = null

      const index = safeLines.findIndex((line) => line.id === lineId)
      const line = safeLines[index]
      const needsTiming = line && (line.start === null || line.end === null)
      if (!needsTiming) return

      const previousTimed = safeLines
        .slice(0, index)
        .findLast((candidate) => candidate.end !== null && Number.isFinite(candidate.end))
      const startFrom = previousTimed?.end ?? 0
      seekToTime(startFrom)
      waveRef.current?.play()
      setStatus(`Untimed line selected. Playback starts from ${formatClock(startFrom)}.`)
    },
    [safeLines, seekToTime],
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

  const handleSpaceDown = useCallback(() => {
    if (step !== 'timing') return
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
    setStatus('')
  }, [activeLine, currentTime, patchLine, step])

  const handleSpaceUp = useCallback(() => {
    if (step !== 'timing') return
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
      setActiveLineId(safeLines[activeIndex + 1].id)
    } else {
      setActiveLineId(activeLine.id)
      enterEditMode()
    }
  }, [activeIndex, activeLine, currentTime, enterEditMode, safeLines, step])

  const togglePlay = useCallback(() => {
    waveRef.current?.playPause()
  }, [])

  const seekToLine = useCallback(
    (line: LyricLine) => {
      if (line.start === null) return
      seekToTime(line.start)
    },
    [seekToTime],
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
      if (isEditableTarget(event.target) || event.repeat) return
      if (event.code === 'Space') {
        event.preventDefault()
        handleSpaceDown()
      }
      if (event.code === 'Escape') {
        event.preventDefault()
        undoLastLine()
      }
      if (event.code === 'ArrowDown') {
        event.preventDefault()
        const next = safeLines[Math.min(safeLines.length - 1, activeIndex + 1)]
        if (next) selectLine(next.id)
      }
      if (event.code === 'ArrowUp') {
        event.preventDefault()
        const previous = safeLines[Math.max(0, activeIndex - 1)]
        if (previous) selectLine(previous.id)
      }
      if (event.code === 'Enter') {
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
  }, [
    activeIndex,
    handleSpaceDown,
    handleSpaceUp,
    playActiveLine,
    safeLines,
    selectLine,
    undoLastLine,
  ])

  const onAudioChange = (file: File | null) => {
    if (!file) return
    setFileDropError('')
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioName(file.name)
    setTtmlSubtitle('')
    setTtmlTitle(file.name.replace(/\.[^.]+$/, ''))
    setTtmlArtist('')
    setAudioUrl(URL.createObjectURL(file))
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)
    setTimingMode('sync')
    setStatus('')
  }

  const onTimedLyricsImport = async (file: File | null) => {
    if (!file) return
    setFileDropError('')

    try {
      const content = await file.text()
      const nextLines = parseTimedLyrics(file.name, content)
      if (!nextLines.length) {
        setStatus('No timed lyric lines found in this file.')
        return
      }

      const nextText = nextLines.map((line) => line.text).join('\n')
      setImportedFileName(file.name)
      setImportedLines(nextLines)
      setImportedLyricsText(nextText)
      setLyricsText(nextText)
      setStatus(`Imported ${nextLines.length} timed lines with timings. Continue opens Edit mode.`)
    } catch (error) {
      setImportedFileName(null)
      setImportedLines([])
      setImportedLyricsText('')
      setStatus(error instanceof Error ? `Import failed: ${error.message}` : 'Import failed.')
    }
  }

  const onLyricsTextChange = (value: string) => {
    setLyricsText(value)
    if (importedLyricsText && value.trim() !== importedLyricsText.trim() && importedLines.length) {
      setStatus('Text changed. Imported timings will be kept by line order.')
    }
  }

  const goToStep = (nextStep: AppStep) => {
    waveRef.current?.pause()
    if (canOpenStep(nextStep)) setStep(nextStep)
  }

  const onTimeEdit = (lineId: string, field: 'start' | 'end', value: string) => {
    const nextValue = value === '' ? null : Number(value)
    patchLine(lineId, {
      [field]: Number.isFinite(nextValue) ? nextValue : null,
      source: 'edited',
    })
  }

  const onTextEdit = (lineId: string, value: string) => {
    patchLine(lineId, {
      text: value,
      source: 'edited',
    })
  }

  const rememberLineCursor = (lineId: string, element: HTMLInputElement) => {
    lineCursorRefs.current.set(lineId, element.selectionStart ?? element.value.length)
  }

  const splitTextAtCursor = (text: string, cursor: number | undefined) => {
    const safeCursor = typeof cursor === 'number' ? cursor : -1
    const canUseCursor = safeCursor > 0 && safeCursor < text.length
    const splitAt = canUseCursor
      ? safeCursor
      : (() => {
          const words = text.trim().split(/\s+/)
          if (words.length < 2) return -1
          const leftWords = words.slice(0, Math.ceil(words.length / 2)).join(' ')
          return text.indexOf(leftWords) + leftWords.length
        })()

    if (splitAt <= 0 || splitAt >= text.length) return null

    const left = text.slice(0, splitAt).trim()
    const right = text.slice(splitAt).trim()
    if (!left || !right) return null
    return { left, right }
  }

  const splitLine = (lineId: string) => {
    setLines((current) => {
      const index = current.findIndex((line) => line.id === lineId)
      const line = current[index]
      if (!line) return current

      const split = splitTextAtCursor(line.text, lineCursorRefs.current.get(lineId))
      if (!split) {
        setStatus('Put cursor inside the line text, or use a line with at least two words.')
        return current
      }

      const first: LyricLine = {
        ...line,
        text: split.left,
        start: null,
        end: null,
        source: 'empty',
      }
      const second: LyricLine = {
        ...line,
        id: `${line.id}-split-${Date.now()}`,
        text: split.right,
        start: null,
        end: null,
        source: 'empty',
      }

      setActiveLineId(first.id)
      setStatus('Line split. Both new lines need manual sync.')
      return [...current.slice(0, index), first, second, ...current.slice(index + 1)]
    })
  }

  const resetLineTiming = (lineId: string) => {
    setLines((current) =>
      current.map((line) =>
        line.id === lineId
          ? {
              ...line,
              start: null,
              end: null,
              source: 'empty',
            }
          : line,
      ),
    )
    setActiveLineId(lineId)
    setSyncStart(null)
    startDraftRef.current = null
    recordingPreviousRef.current = null
    setStatus('Line timing reset. Hold Space to sync it again.')
  }

  const deleteLine = (lineId: string) => {
    setLines((current) => {
      const next = current.filter((line) => line.id !== lineId)
      if (activeLineId === lineId) {
        const deletedIndex = current.findIndex((line) => line.id === lineId)
        const fallback = next[Math.min(Math.max(0, deletedIndex), Math.max(0, next.length - 1))]
        setActiveLineId(fallback?.id ?? null)
      }
      return next
    })
    setHistory((current) => current.filter((entry) => entry.lineId !== lineId))
  }

  const saveAndOpenOut = () => {
    waveRef.current?.pause()
    setLines((current) => current.filter((line) => line.text.trim()))
    if (hasTimedLines) setStep('out')
  }

  const exportFile = (format: 'ttml' | 'lrc' | 'json') => {
    const base = (audioName ?? 'stars-clique-sync-lite').replace(/\.[^.]+$/, '')
    if (format === 'ttml') {
      if (ttmlIssues.length) return
      downloadText(ttmlFilename(ttmlOptions, base), exportTtml(safeLines, ttmlOptions))
    }
    if (format === 'lrc') downloadText(`${base}.lrc`, exportLrc(safeLines))
    if (format === 'json') downloadText(`${base}.scsync.json`, exportProject(safeLines, audioName))
  }

  const reviewExportLine = (number: number) => {
    const line = safeLines[number - 1]
    if (!line) return
    waveRef.current?.pause()
    setActiveLineId(line.id)
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
          onClick={() => goToStep(item)}
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
      <input
        className="seek-slider"
        type="range"
        min="0"
        max={duration || 0}
        step="0.01"
        value={duration ? Math.min(currentTime, duration) : 0}
        disabled={!duration}
        aria-label="Track position"
        onChange={(event) => seekToTime(Number(event.target.value))}
      />
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
          } ${line.start !== null && line.end !== null && index < activeIndex ? 'synced' : ''}`}
          onClick={() => selectLine(line.id)}
          onDoubleClick={() => seekToLine(line)}
        >
          <span className="line-number">{pad(index + 1)}</span>
          {timingMode === 'edit' && !compact ? (
            <input
              className="line-text-input"
              value={line.text}
              onClick={(event) => {
                event.stopPropagation()
                rememberLineCursor(line.id, event.currentTarget)
              }}
              onKeyUp={(event) => rememberLineCursor(line.id, event.currentTarget)}
              onSelect={(event) => rememberLineCursor(line.id, event.currentTarget)}
              onChange={(event) => {
                onTextEdit(line.id, event.target.value)
                rememberLineCursor(line.id, event.currentTarget)
              }}
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
            <div className="row-actions">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  splitLine(line.id)
                }}
              >
                Split
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  resetLineTiming(line.id)
                }}
              >
                Reset
              </button>
              <button
                type="button"
                className="danger-action"
                onClick={(event) => {
                  event.stopPropagation()
                  deleteLine(line.id)
                }}
              >
                Del
              </button>
            </div>
          )}
        </div>
      ))}
      {!safeLines.length && <div className="empty-state">No lines prepared yet.</div>}
    </div>
  )

  const onFileDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsFileOver(true)
  }

  const onFileDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setIsFileOver(false)
  }

  const onFileDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    setIsFileOver(false)
    const { audio, lyrics, error } = classifyDroppedFiles(event.dataTransfer.files, true)
    if (error) {
      setFileDropError(error)
      return
    }
    if (audio) onAudioChange(audio)
    if (lyrics) void onTimedLyricsImport(lyrics)
  }

  const canDropFiles = step === 'in'

  return (
    <main
      className={canDropFiles && isFileOver ? 'app-shell is-file-over' : 'app-shell'}
      onDragOver={canDropFiles ? onFileDragOver : undefined}
      onDragLeave={onFileDragLeave}
      onDrop={canDropFiles ? onFileDrop : undefined}
    >
      <header className="app-header">
        <div>
          <p>Stars Clique Sync Lite <span>v1</span></p>
          <h1>{stepLabels[step]}</h1>
        </div>
        {renderStepNav()}
      </header>

      {step === 'in' && (
        <section className="screen in-screen">
          <div className="surface intro-copy">
            <h2>Start a manual sync project</h2>
            <p>Load audio, paste lyrics, then hold Space line by line.</p>
          </div>

          <div className="surface input-card">
            <div className="field-head">
              <FileAudio size={18} />
              <span>Audio</span>
            </div>
            <label className="file-input">
              <input type="file" accept="audio/*" onChange={(event) => {
                onAudioChange(event.currentTarget.files?.[0] ?? null)
                event.currentTarget.value = ''
              }} />
              <strong>{audioName ?? 'Choose or drop audio'}</strong>
            </label>
            {fileDropError && <p className="file-drop-error" role="status">{fileDropError}</p>}
          </div>

          <div className="surface input-card">
            <div className="field-head">
              <FileText size={18} />
              <span>Lyrics</span>
            </div>
            <textarea
              value={lyricsText}
              placeholder="Paste lyrics here"
              onChange={(event) => onLyricsTextChange(event.target.value)}
            />
            <label className="file-input timed-import">
              <input
                type="file"
                accept=".lrc,.ttml,.xml,text/plain,application/xml"
                onChange={(event) => {
                  void onTimedLyricsImport(event.currentTarget.files?.[0] ?? null)
                  event.currentTarget.value = ''
                }}
              />
              <strong>{importedFileName ?? 'Import LRC / TTML for edit'}</strong>
            </label>
            {status && <div className="status-note inline"><span>{status}</span></div>}
          </div>

          <button type="button" className="continue-btn" disabled={!canContinueFromIn} onClick={prepareProject}>
            Continue
            <ArrowRight size={18} />
          </button>
        </section>
      )}

      {step === 'timing' && (
        <section className="screen sync-screen">
          {renderWaveform()}

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
              <button type="button" onClick={undoLastLine} disabled={!history.length}>
                <RotateCcw size={17} />
                Undo
              </button>
              {timingMode === 'sync' ? (
                <button type="button" disabled={!hasTimedLines} onClick={enterEditMode}>
                  Edit
                  <ArrowRight size={17} />
                </button>
              ) : (
                <button type="button" disabled={!hasTimedLines} onClick={saveAndOpenOut}>
                  Save
                  <ArrowRight size={17} />
                </button>
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
                <span>Edit text, timings, split rows, or delete rows</span>
                <span><kbd>Space</kbd> hold to resync selected line</span>
                <span><kbd>Enter</kbd> replay selected line</span>
              </div>
            )}
          </div>

          <div className="surface editor-card">
            <div className="edit-toolbar">
              <div>
                <span>{timingMode === 'sync' ? 'Manual timing' : 'Edit mode'}</span>
                <strong>{timedLines.length} of {safeLines.length} lines timed</strong>
              </div>
              <button type="button" onClick={playActiveLine} disabled={!activeLine || activeLine.start === null}>
                <Play size={16} />
                Replay
              </button>
            </div>
            {status && <div className="status-note inline"><span>{status}</span></div>}
            {renderLineList()}
          </div>
        </section>
      )}

      {step === 'out' && (
        <section className="screen out-screen">
          <div className="surface export-summary">
            <Check size={22} />
            <h2>{ttmlIssues.length ? 'Review export' : 'Export ready'}</h2>
            <p>{timedLines.length} of {safeLines.length} lines timed. {ttmlIssues.length ? 'TTML needs review.' : 'TTML checks passed.'}</p>
          </div>

          <section className="surface ttml-options ttml-metadata" aria-label="Track details">
            <label>Title<input placeholder="Optional" value={ttmlTitle} onChange={(event) => setTtmlTitle(event.target.value)} /></label>
            <label>Subtitle<input placeholder="Optional" value={ttmlSubtitle} onChange={(event) => setTtmlSubtitle(event.target.value)} /></label>
            <label>Artist<input placeholder="Optional" value={ttmlArtist} onChange={(event) => setTtmlArtist(event.target.value)} /></label>
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


          <div className="surface export-card">
            <div className="export-actions">
              <button type="button" className="primary-action" disabled={ttmlIssues.length > 0} onClick={() => exportFile('ttml')}>
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
          </div>
        </section>
      )}
      <footer className="app-footer">
        <span>Stars Clique</span>
        <span>Developed by Mikhail Mikhalchenko (Goth Angel)</span>
        <span>Non-commercial redistribution only</span>
        <a href="https://t.me/starsclique" target="_blank" rel="noreferrer">Telegram</a>
      </footer>
    </main>
  )
}

export default App
