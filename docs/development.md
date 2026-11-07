# Build and Run Stars Clique Sync

Use Node.js 24 with npm. Auto also needs Python 3.14 and its dependencies.
The Windows packaging commands target x64 and use PowerShell.

## Lite on GitHub Pages

The hosted [Lite app](https://9519860664r-oss.github.io/stars-clique-sync/) is
built by [the Pages workflow](../.github/workflows/deploy-lite.yml). Pushes to
`main` that change `lite/` or the workflow trigger deployment. You can also
start the workflow manually from the repository's Actions tab.

The workflow checks and builds Lite on Node.js 24 with the repository path as
Vite's base URL, then publishes `lite/dist/`. Set the repository's Pages source
to GitHub Actions. Audio and lyric editing run in the visitor's browser.

## How to Run Auto

In the first terminal, from the repository root:

```powershell
cd auto/backend
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe desktop_backend.py
```

In a second terminal, from the repository root:

```powershell
cd auto
npm ci
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open [127.0.0.1:5173](http://127.0.0.1:5173/). The backend health endpoint is
[127.0.0.1:8765/health](http://127.0.0.1:8765/health). The first recognition
needs internet access to download the model. The backend processes audio
locally and uses Hugging Face's normal cache location unless `HF_HOME` is set.
The packaged app places the model cache in its Electron user data directory.

If recognition fails to initialize on your system, set
`STARS_SYNC_WHISPER_DEVICE=cpu` and `STARS_SYNC_WHISPER_COMPUTE=int8` before
starting the backend and retry. Check that ports 5173 and 8765 are free before
starting a second Auto instance.

## How to Build Windows Installers

For Lite, run these commands from `lite/`:

```powershell
npm ci
npm run dist
```

For Auto, prepare the bundled backend first. From `auto/backend/`:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-build.txt
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --onedir --name stars-sync-backend --collect-all faster_whisper --collect-all ctranslate2 --collect-all tokenizers --collect-all onnxruntime --collect-all av --collect-all huggingface_hub desktop_backend.py
cd ..
npm ci
npm run dist
```

Each installer appears in that edition's `release/` directory. The Auto
installer bundles the backend and downloads the model on first use. Native
AI dependencies may require the Microsoft Visual C++ Redistributable on a
clean Windows system.

To build the web interface only, run `npm run build` in the edition folder.
Run `npm run lint` there to check the frontend and Electron code.

## Backend Reference

The Auto UI sends requests to `http://127.0.0.1:8765`. This service binds to
loopback. Its allowed browser origins are `http://127.0.0.1:5173` and
`http://localhost:5173`. Hosting the Auto frontend remotely requires configuring
both the API address and its allowed origins.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /health` | None | Readiness and current model settings |
| `POST /transcribe` | Multipart `audio` file and optional `language` | Status, transcript, detected language, model, and timed lines |

The UI offers `auto`, `en`, and `ru`. The API also accepts `uk`, `es`,
`fr`, `de`, `it`, and `pl`. View the actual response fields in
[`auto/backend/server.py`](../auto/backend/server.py).

```powershell
curl.exe -F "audio=@track.mp3" -F "language=en" http://127.0.0.1:8765/transcribe
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `STARS_SYNC_WHISPER_MODEL` | `medium` | faster-whisper model |
| `STARS_SYNC_WHISPER_DEVICE` | `auto` | Inference device |
| `STARS_SYNC_WHISPER_COMPUTE` | `auto` | Inference precision |
| `STARS_SYNC_WHISPER_LANGUAGE` | Empty | Default language hint |
| `STARS_SYNC_WHISPER_PROMPT` | Empty | Optional initial prompt |
| `STARS_SYNC_PHRASE_MAX_WORDS` | `12` | Phrase-length target in words |
| `STARS_SYNC_PHRASE_MAX_SECONDS` | `5.0` | Phrase-duration target |
| `STARS_SYNC_PHRASE_PAUSE_SECONDS` | `0.55` | Pause used to identify phrase breaks |

For everyday workflows, open the [English PDF guide](stars-clique-sync-guide-en.pdf)
or the [Russian PDF guide](stars-clique-sync-guide-ru.pdf).

## How to Regenerate the Manuals

On Windows, with Segoe UI and Consolas installed, run from the repository root:

```powershell
py -3.14 -m pip install reportlab
py -3.14 tools/build_manuals.py
```

The generator writes both PDFs to `docs/`.
