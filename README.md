<p align="center">
  <img src="lite/build/icon.png" alt="Stars Clique Sync icon" width="104">
</p>

<h1 align="center">Stars Clique Sync</h1>
<p align="center">Line-by-line lyric timing for music. Export TTML, LRC, or project JSON.</p>
<p align="center">
  A Stars Clique project · Developed by <strong>Mikhail Mikhalchenko (Goth Angel)</strong>
</p>
<p align="center">
  <a href="docs/stars-clique-sync-guide-en.pdf">English manual (PDF)</a> ·
  <a href="docs/stars-clique-sync-guide-ru.pdf">Руководство на русском (PDF)</a> ·
  <a href="https://t.me/starsclique">Stars Clique on Telegram</a>
</p>

## Editions

| Edition | Workflow |
| --- | --- |
| **Lite** | Time your own lyrics by holding Space. Import existing LRC or TTML and edit the text and timings. Runs without Whisper or a separate server. |
| **Auto** | Use the manual workflow or create a draft with local Whisper recognition. You can paste existing lyrics or recognize them from the track. |

Both editions let you review the waveform, adjust timestamps, replay lines,
and export your work. The Auto edition can align supplied lyrics against the
track while keeping the supplied words.

## Quick Start

Run the Lite web app from a checkout with Node.js 24 and npm installed.

```sh
cd lite
npm ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Open [127.0.0.1:5174](http://127.0.0.1:5174/). Choose an audio file, paste one
lyric phrase per line, and select **Continue**. Press Space at the start of each
phrase and release it at the end. Review the result in **Edit**, then select
**Save** and choose an export format.

See the [developer guide](docs/development.md) for the Auto backend, Windows
installers, and integration details.

## Recognition Quality

**Automatic recognition produces an editable draft.** Singing, heavy effects,
backing vocals, dense mixes, and fast delivery can cause wrong, missing, or
invented words in English and Russian. Timing can drift even when the words
are correct. Review the transcript and timestamps by ear before exporting.

The Auto edition uses Whisper `medium` by default. On an internal set of
20 full tracks, it scored 42.6% word error rate (WER), compared with 44.2% for
`large-v3`. On the nine tracks with human-annotated reference lyrics, scores
were 27.3% and 24.2%, respectively. Lower WER is better. This small test is
illustrative. Some artist-provided references abbreviate repeated sections.

## Attribution and License

Stars Clique Sync is **source-available**. You may adapt it and share it
non-commercially under the [project license](LICENSE.md). Keep the Stars Clique
branding and the original developer credit. Label any public modified build
as unofficial and identify your changes.
