const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const isDev = !app.isPackaged
const iconPath = isDev
  ? path.join(__dirname, '..', 'build', 'icon.png')
  : path.join(process.resourcesPath, 'icon.png')

let backendProcess = null
let staticServer = null

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

function startStaticServer() {
  if (isDev || staticServer) return

  const distDir = path.join(__dirname, '..', 'dist')
  staticServer = http.createServer((request, response) => {
    const rawUrl = request.url?.split('?')[0] || '/'
    const safeUrl = rawUrl === '/' ? '/index.html' : decodeURIComponent(rawUrl)
    const requestedPath = path.normalize(path.join(distDir, safeUrl))
    const filePath = requestedPath.startsWith(distDir)
      ? requestedPath
      : path.join(distDir, 'index.html')
    const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
      ? filePath
      : path.join(distDir, 'index.html')

    fs.readFile(finalPath, (error, data) => {
      if (error) {
        response.writeHead(500)
        response.end('Cannot load app')
        return
      }
      response.writeHead(200, { 'Content-Type': contentType(finalPath) })
      response.end(data)
    })
  })

  staticServer.listen(5173, '127.0.0.1')
}

function startBackend() {
  if (isDev || backendProcess) return

  const backendDir = path.join(process.resourcesPath, 'backend')
  const backendExe = path.join(backendDir, 'stars-sync-backend', 'stars-sync-backend.exe')

  backendProcess = spawn(
    backendExe,
    [],
    {
      cwd: backendDir,
      windowsHide: true,
      env: {
        ...process.env,
        HF_HOME: path.join(app.getPath('userData'), 'hf-cache'),
        PIP_CACHE_DIR: path.join(app.getPath('userData'), 'pip-cache'),
        STARS_SYNC_WHISPER_MODEL: process.env.STARS_SYNC_WHISPER_MODEL || 'medium',
        STARS_SYNC_WHISPER_DEVICE: process.env.STARS_SYNC_WHISPER_DEVICE || 'auto',
        STARS_SYNC_WHISPER_COMPUTE: process.env.STARS_SYNC_WHISPER_COMPUTE || 'auto',
      },
    },
  )

  backendProcess.on('exit', () => {
    backendProcess = null
  })
}

function createWindow() {
  startStaticServer()
  startBackend()

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#070709',
    title: 'Stars Clique Sync Auto',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.removeMenu()

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    window.loadURL('http://127.0.0.1:5173/')
  } else {
    window.loadURL('http://127.0.0.1:5173/')
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  if (staticServer) {
    staticServer.close()
    staticServer = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
