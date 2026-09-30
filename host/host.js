// Native messaging host for the Video Downloader extension.
//
// Chrome starts this process and talks to it over stdin/stdout using the
// native messaging protocol: each message is JSON, prefixed by a 4-byte
// length. NEVER write anything else to stdout, or Chrome will drop the link.
//
// The yt-dlp / ffmpeg logic is ported from https://github.com/pablostanley/yoinks
// (MIT, (c) Pablo Stanley).
import {spawn} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

const HOST_VERSION = '0.1.0'
const BIN_DIR = path.join(os.homedir(), '.video-downloader', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Downloads')
const MAX_VIDEO_CHOICES = 8

// ---------------------------------------------------------------------------
// Native messaging transport
// ---------------------------------------------------------------------------

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  if (os.endianness() === 'LE') header.writeUInt32LE(body.length)
  else header.writeUInt32BE(body.length)
  process.stdout.write(Buffer.concat([header, body]))
}

let inbox = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  inbox = Buffer.concat([inbox, chunk])
  while (inbox.length >= 4) {
    const length = os.endianness() === 'LE' ? inbox.readUInt32LE(0) : inbox.readUInt32BE(0)
    if (inbox.length < 4 + length) break
    const raw = inbox.subarray(4, 4 + length)
    inbox = inbox.subarray(4 + length)
    let message
    try {
      message = JSON.parse(raw.toString('utf8'))
    } catch {
      continue
    }
    handle(message).catch(error => {
      send({type: 'error', id: message?.id, message: error?.message ?? String(error)})
    })
  }
})
// Chrome closed the port (popup/worker gone): stop everything and leave.
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
  for (const job of jobs.values()) job.child?.kill('SIGTERM')
  void cleanupProbes().finally(() => process.exit(0))
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** id -> {child, aborted, destinations} for running downloads */
const jobs = new Map()
/** probeId -> {infoJsonPath, choices} for analyzed URLs */
const probes = new Map()
let ytdlpPromise
let ffmpegPromise

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

async function handle(message) {
  switch (message?.type) {
    case 'hello': {
      const ytdlp = await getYtDlp()
      const ffmpeg = await getFfmpeg()
      send({
        type: 'ready',
        id: message.id,
        version: HOST_VERSION,
        ytdlp: ytdlp === 'yt-dlp' ? 'system' : 'bundled',
        ffmpeg: ffmpeg.available,
        defaultOutDir: DEFAULT_OUT_DIR,
      })
      return
    }
    case 'probe':
      return handleProbe(message)
    case 'download':
      return handleDownload(message)
    case 'cancel':
      jobs.get(message.id)?.cancel()
      return
    case 'reveal':
      return handleReveal(message)
    default:
      send({type: 'error', id: message?.id, message: `Unknown message type: ${message?.type}`})
  }
}

function parseHttpUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error('That does not look like a valid link.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links are supported.')
  }
  return url.href
}

async function handleProbe({id, url}) {
  const href = parseHttpUrl(url)
  const ytdlp = await getYtDlp(status => send({type: 'status', id, message: status}))
  const {info, infoJsonPath} = await probe(ytdlp, href)
  const choices = buildChoices(info)
  const probeId = `${process.pid}-${Date.now()}-${probes.size}`
  probes.set(probeId, {infoJsonPath, choices})
  send({
    type: 'probed',
    id,
    probeId,
    title: info.title ?? 'Untitled video',
    uploader: info.uploader ?? info.channel ?? undefined,
    duration: info.duration,
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : undefined,
    site: info.extractor_key,
    choices: choices.map(({label, kind}, index) => ({index, label, kind})),
  })
}

async function handleDownload({id, url, probeId, choiceIndex, outDir, referer}) {
  if (jobs.has(id)) throw new Error('That download is already running.')
  const href = parseHttpUrl(url)
  const probed = probeId ? probes.get(probeId) : undefined
  const choice = probed?.choices[choiceIndex ?? 0] ?? fallbackChoice()
  const dir = await resolveOutDir(outDir)
  const ytdlp = await getYtDlp(status => send({type: 'status', id, message: status}))
  const ffmpeg = await getFfmpeg()

  send({type: 'started', id})
  try {
    const filepath = await download(
      {
        ytdlp,
        ffmpegLocation: ffmpeg.location,
        url: href,
        infoJsonPath: probed?.infoJsonPath,
        choice,
        outDir: dir,
        referer: typeof referer === 'string' && /^https?:\/\//.test(referer) ? referer : undefined,
        jobId: id,
      },
      {
        onProgress: progress => send({type: 'progress', id, ...progress}),
        onProcessing: () => send({type: 'processing', id}),
      },
    )
    send({type: 'done', id, filepath})
  } catch (error) {
    send({type: 'failed', id, message: error?.message ?? String(error), cancelled: error?.cancelled === true})
  }
}

async function resolveOutDir(requested) {
  let dir = typeof requested === 'string' && requested.trim() ? requested.trim() : DEFAULT_OUT_DIR
  if (dir === '~') dir = os.homedir()
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(2))
  if (!path.isAbsolute(dir)) throw new Error('The save folder must be a full path, like ~/Downloads.')
  try {
    await fs.mkdir(dir, {recursive: true})
  } catch (error) {
    throw new Error(`Could not use the save folder "${dir}": ${error.message}`)
  }
  return dir
}

function handleReveal({filepath}) {
  if (typeof filepath !== 'string' || !path.isAbsolute(filepath)) return
  let command
  let args
  if (process.platform === 'darwin') {
    command = 'open'
    args = ['-R', filepath]
  } else if (process.platform === 'win32') {
    command = 'explorer.exe'
    args = [`/select,${filepath}`]
  } else {
    command = 'xdg-open'
    args = [path.dirname(filepath)]
  }
  try {
    const child = spawn(command, args, {stdio: 'ignore', detached: true})
    child.on('error', () => {})
    child.unref()
  } catch {
    // nothing sensible to do if the file manager is missing
  }
}

// ---------------------------------------------------------------------------
// yt-dlp / ffmpeg discovery (from yoinks/src/lib/ytdlp.ts)
// ---------------------------------------------------------------------------

function ytDlpAssetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

function commandWorks(cmd, args) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** System yt-dlp first, then our own copy, then download the standalone binary. */
function getYtDlp(onStatus = () => {}) {
  ytdlpPromise ??= ensureYtDlp(onStatus).catch(error => {
    ytdlpPromise = undefined // allow a retry on the next request
    throw error
  })
  return ytdlpPromise
}

async function ensureYtDlp(onStatus) {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('First run: fetching yt-dlp…')
  await fs.mkdir(BIN_DIR, {recursive: true})

  const response = await fetch(`${RELEASE_BASE}/${ytDlpAssetName()}`)
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }
  const tmp = `${local}.download`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp))
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

/** System ffmpeg first, optional ffmpeg-static as fallback. */
function getFfmpeg() {
  ffmpegPromise ??= findFfmpeg()
  return ffmpegPromise
}

async function findFfmpeg() {
  if (await commandWorks('ffmpeg', ['-version'])) return {available: true, location: undefined}
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = mod.default ?? mod
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) {
      return {available: true, location: ffmpegPath}
    }
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return {available: false, location: undefined}
}

// ---------------------------------------------------------------------------
// Probe + format choices (from yoinks/src/lib/ytdlp.ts)
// ---------------------------------------------------------------------------

async function probe(ytdlp, url) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', '--', url])
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      else resolve(out)
    })
  })

  let info
  try {
    info = JSON.parse(stdout)
  } catch {
    throw new Error('Could not read the video info from yt-dlp.')
  }
  const infoJsonPath = path.join(os.tmpdir(), `video-downloader-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function fallbackChoice() {
  return {kind: 'video', label: 'best available · mp4', args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']}
}

function buildChoices(info) {
  const formats = info.formats ?? []
  const choices = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const best = [...videos.filter(f => f.height === height)].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : (audioSize ?? 0))
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) choices.push(fallbackChoice())

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })
  return choices
}

function scoreVideo(f) {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

async function cleanupProbes() {
  await Promise.allSettled([...probes.values()].map(p => fs.rm(p.infoJsonPath, {force: true})))
  probes.clear()
}

// ---------------------------------------------------------------------------
// Download with progress (from yoinks/src/lib/ytdlp.ts)
// ---------------------------------------------------------------------------

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

function download(opts, handlers) {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : []),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which hides the progress and the
    // [Merger]/[ExtractAudio] lines we rely on
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.referer) args.push('--referer', opts.referer)
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)
  // "--" so a link can never be read as an option
  if (!opts.infoJsonPath) args.push('--', opts.url)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args)
    const job = {
      child,
      aborted: false,
      cancel() {
        job.aborted = true
        child.kill('SIGTERM')
      },
    }
    jobs.set(opts.jobId, job)

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes, so a cancel can clean up after itself
    const destinations = []

    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      jobs.delete(opts.jobId)
      reject(error)
    })
    child.on('close', code => {
      jobs.delete(opts.jobId)
      if (job.aborted) {
        void removePartials(destinations)
        reject(Object.assign(new Error('Download cancelled.'), {cancelled: true}))
      } else if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations) {
  return Promise.allSettled(
    destinations.flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`]).map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value) {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr) {
  const last = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
    .at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
