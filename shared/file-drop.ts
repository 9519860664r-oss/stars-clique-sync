const audioExtension = /\.(?:aac|aif|aiff|flac|m4a|m4b|mp3|mp4|oga|ogg|opus|wav|wave|webm|wma)$/i
const timedLyricsExtension = /\.(?:lrc|ttml|xml)$/i

export function isFileDrag(transfer: Pick<DataTransfer, 'types'>) {
  return transfer.types.includes('Files')
}

export function preventFileNavigation() {
  const prevent = (event: DragEvent) => {
    if (event.dataTransfer && isFileDrag(event.dataTransfer) && !event.defaultPrevented) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
    }
  }
  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
  return () => {
    window.removeEventListener('dragover', prevent)
    window.removeEventListener('drop', prevent)
  }
}

export function classifyDroppedFiles(files: FileList | readonly File[], allowTimedLyrics: boolean) {
  let audio: File | undefined
  let lyrics: File | undefined
  for (const file of Array.from(files)) {
    if (timedLyricsExtension.test(file.name)) {
      if (!allowTimedLyrics) return { error: 'Drop one audio file.' }
      if (lyrics) return { error: 'Drop one LRC or TTML file at a time.' }
      lyrics = file
    } else if (file.type.startsWith('audio/') || audioExtension.test(file.name)) {
      if (audio) return { error: 'Drop one audio file at a time.' }
      audio = file
    } else {
      return { error: allowTimedLyrics ? 'Drop an audio, LRC, or TTML file.' : 'Drop one audio file.' }
    }
  }
  return { audio, lyrics }
}
