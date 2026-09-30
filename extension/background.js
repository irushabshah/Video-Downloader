// Background service worker.
//
// Owns the link to the local helper (native messaging host), keeps the list of
// downloads, and watches network responses for video files on each tab.
// The popup only talks to this file.

const HOST_NAME = 'com.videodownloader.host'
const IDLE_CLOSE_MS = 60_000
const MAX_HISTORY = 20

// --- State ------------------------------------------------------------------

const state = {
  host: {status: 'unknown', error: undefined, info: undefined}, // unknown | connecting | ready | missing
  analyses: {}, // page url -> {status: 'loading'|'ready'|'error', data?, error?, message?}
  jobs: {}, // job id -> {id, title, url, status, ...}
}
const ready = loadJobs()

async function loadJobs() {
  const {jobs = {}} = await chrome.storage.local.get('jobs')
  for (const job of Object.values(jobs)) {
    // A worker restart drops the helper, which stops its downloads.
    if (job.status === 'running' || job.status === 'processing' || job.status === 'queued') {
      job.status = 'failed'
      job.error = 'Interrupted. Try again.'
    }
  }
  state.jobs = jobs
}

let saveTimer
function persistJobs() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const newest = Object.values(state.jobs)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY)
    state.jobs = Object.fromEntries(newest.map(job => [job.id, job]))
    void chrome.storage.local.set({jobs: state.jobs})
  }, 300)
}

function broadcast() {
  chrome.runtime.sendMessage({type: 'state', state: snapshot()}).catch(() => {
    // no popup open, nothing to tell
  })
}

function snapshot() {
  return {host: state.host, analyses: state.analyses, jobs: state.jobs}
}

// --- Native host link -------------------------------------------------------

let port
let idleTimer
const pending = new Map() // request id -> {resolve, reject, onStatus}

function connect() {
  if (port) return port
  state.host = {...state.host, status: 'connecting'}
  port = chrome.runtime.connectNative(HOST_NAME)
  port.onMessage.addListener(onHostMessage)
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message
    port = undefined
    const missing = reason && /not found|forbidden|not exist/i.test(reason)
    state.host = {status: missing ? 'missing' : 'unknown', error: reason, info: undefined}
    for (const job of Object.values(state.jobs)) {
      if (job.status === 'running' || job.status === 'processing' || job.status === 'queued') {
        job.status = 'failed'
        job.error = reason ? `Helper stopped: ${reason}` : 'Helper stopped.'
      }
    }
    for (const [, request] of pending) request.reject(new Error(reason || 'The helper stopped.'))
    pending.clear()
    persistJobs()
    broadcast()
  })
  return port
}

function closeWhenIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    const busy = Object.values(state.jobs).some(j => ['queued', 'running', 'processing'].includes(j.status))
    if (port && !busy && pending.size === 0) {
      port.disconnect()
      port = undefined
      state.host = {...state.host, status: state.host.status === 'ready' ? 'unknown' : state.host.status}
      broadcast()
    } else if (port) {
      closeWhenIdle()
    }
  }, IDLE_CLOSE_MS)
}

function request(message, onStatus) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, {resolve, reject, onStatus})
    try {
      connect().postMessage({...message, id})
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
    closeWhenIdle()
  })
}

function onHostMessage(message) {
  closeWhenIdle()
  const waiting = pending.get(message.id)

  switch (message.type) {
    case 'status':
      if (waiting) waiting.onStatus?.(message.message)
      else if (state.jobs[message.id]) {
        state.jobs[message.id].note = message.message
        broadcast()
      }
      return
    case 'ready':
    case 'probed':
      pending.delete(message.id)
      waiting?.resolve(message)
      return
    case 'error':
      if (waiting) {
        pending.delete(message.id)
        waiting.reject(new Error(message.message))
      } else if (state.jobs[message.id]) {
        // the helper refused a download before it began
        state.jobs[message.id].status = 'failed'
        state.jobs[message.id].error = message.message
        persistJobs()
        broadcast()
      }
      return
  }

  // Everything else is about a running download.
  const job = state.jobs[message.id]
  if (!job) return
  if (message.type === 'started') job.status = 'running'
  else if (message.type === 'progress') {
    job.status = 'running'
    job.downloadedBytes = message.downloadedBytes
    job.totalBytes = message.totalBytes
    job.speed = message.speed
    job.eta = message.eta
    job.part = message.part
    job.totalParts = message.totalParts
  } else if (message.type === 'processing') job.status = 'processing'
  else if (message.type === 'done') {
    job.status = 'done'
    job.filepath = message.filepath
  } else if (message.type === 'failed') {
    job.status = message.cancelled ? 'cancelled' : 'failed'
    job.error = message.message
  }
  persistJobs()
  broadcast()
}

async function ensureHost() {
  if (state.host.status === 'ready' && port) return state.host.info
  try {
    const info = await request({type: 'hello'}, note => {
      state.host.note = note
      broadcast()
    })
    state.host = {status: 'ready', error: undefined, info}
    broadcast()
    return info
  } catch (error) {
    if (state.host.status !== 'missing') state.host = {status: 'unknown', error: error.message, info: undefined}
    broadcast()
    throw error
  }
}

// --- Actions from the popup -------------------------------------------------

async function analyze(url) {
  state.analyses[url] = {status: 'loading'}
  broadcast()
  try {
    await ensureHost()
    const data = await request({type: 'probe', url}, message => {
      state.analyses[url] = {status: 'loading', message}
      broadcast()
    })
    state.analyses[url] = {status: 'ready', data}
  } catch (error) {
    state.analyses[url] = {status: 'error', error: error.message}
  }
  broadcast()
}

async function startDownload({url, probeId, choiceIndex, title, outDir, referer}) {
  await ready
  const id = crypto.randomUUID()
  state.jobs[id] = {id, url, title: title || url, status: 'queued', createdAt: Date.now()}
  persistJobs()
  broadcast()
  try {
    await ensureHost()
    connect().postMessage({type: 'download', id, url, probeId, choiceIndex, outDir, referer})
  } catch (error) {
    state.jobs[id].status = 'failed'
    state.jobs[id].error = error.message
    persistJobs()
    broadcast()
  }
}

function sanitizeFilename(name) {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video'
  )
}

async function downloadDirect({url, title}) {
  const ext = /\.(mp4|webm|mov|m4v|mkv|ogv)(?:$|\?)/i.exec(new URL(url).pathname + '?')?.[1]?.toLowerCase()
  const options = {url, saveAs: false}
  if (ext) options.filename = `${sanitizeFilename(title || 'video')}.${ext}`
  await chrome.downloads.download(options)
}

function forget(id) {
  delete state.jobs[id]
  persistJobs()
  broadcast()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'getState':
      ready.then(() => sendResponse(snapshot()))
      return true
    case 'connect':
      ensureHost().catch(() => {})
      sendResponse()
      return
    case 'analyze':
      void analyze(message.url)
      sendResponse()
      return
    case 'download':
      void startDownload(message)
      sendResponse()
      return
    case 'downloadDirect':
      downloadDirect(message)
        .then(() => sendResponse({ok: true}))
        .catch(error => sendResponse({ok: false, error: error.message}))
      return true
    case 'cancel':
      port?.postMessage({type: 'cancel', id: message.id})
      sendResponse()
      return
    case 'reveal':
      port?.postMessage({type: 'reveal', filepath: message.filepath})
      sendResponse()
      return
    case 'forget':
      forget(message.id)
      sendResponse()
      return
    case 'getDetected':
      getDetected(message.tabId).then(sendResponse)
      return true
  }
})

// --- Spotting videos on pages ----------------------------------------------

const MEDIA_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|mpd)$/i
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|aac|m4a|mp3|vtt|srt)$/i
const SKIP_HOSTS = /(^|\.)(googlevideo\.com)$/i // YouTube chunks: use "Find formats" on the page instead
const MIN_VIDEO_BYTES = 300 * 1024

const detectedByTab = new Map() // tabId -> Map(url -> item)

function classify(url, headers, status) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (SKIP_HOSTS.test(parsed.hostname) || SEGMENT_EXT.test(parsed.pathname)) return undefined

  const header = name => headers?.find(h => h.name.toLowerCase() === name)?.value
  const type = (header('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'video/mp2t' || type === 'video/iso.segment') return undefined

  const isManifest =
    /mpegurl/.test(type) || type === 'application/dash+xml' || /\.(m3u8|mpd)$/i.test(parsed.pathname)
  const isVideo = type.startsWith('video/') || MEDIA_EXT.test(parsed.pathname)
  if (!isManifest && !isVideo) return undefined

  // A ranged response reports the whole file size after the slash.
  const range = /\/(\d+)$/.exec(header('content-range') ?? '')
  const size = Number(range?.[1] ?? header('content-length') ?? 0) || undefined
  if (!isManifest && status !== 206 && size !== undefined && size < MIN_VIDEO_BYTES) return undefined
  if (!isManifest && size === undefined && status === 206) return undefined

  return {url, kind: isManifest ? 'stream' : 'file', size, type: type || undefined}
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0) return
    const item = classify(details.url, details.responseHeaders, details.statusCode)
    if (!item) return
    const key = details.url.split('#')[0]
    let items = detectedByTab.get(details.tabId)
    if (!items) detectedByTab.set(details.tabId, (items = new Map()))
    if (items.has(key)) return
    items.set(key, {...item, foundAt: Date.now()})
    void saveDetected(details.tabId)
    void chrome.action.setBadgeText({tabId: details.tabId, text: String(items.size)})
    void chrome.action.setBadgeBackgroundColor({tabId: details.tabId, color: '#e0245e'})
  },
  {urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other']},
  ['responseHeaders'],
)

async function saveDetected(tabId) {
  const items = detectedByTab.get(tabId)
  await chrome.storage.session.set({[`detected:${tabId}`]: items ? [...items.values()] : []})
}

async function getDetected(tabId) {
  const live = detectedByTab.get(tabId)
  if (live) return [...live.values()]
  // The worker may have restarted since these were seen.
  const stored = (await chrome.storage.session.get(`detected:${tabId}`))[`detected:${tabId}`] ?? []
  if (stored.length) detectedByTab.set(tabId, new Map(stored.map(item => [item.url.split('#')[0], item])))
  return stored
}

function resetTab(tabId) {
  detectedByTab.delete(tabId)
  void chrome.storage.session.remove(`detected:${tabId}`)
  void chrome.action.setBadgeText({tabId, text: ''})
}

// A new page in the tab means the old list no longer applies.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) resetTab(tabId)
})
chrome.tabs.onRemoved.addListener(resetTab)
