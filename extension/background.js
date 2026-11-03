// Background service worker.
//
// Owns the link to the local helper (native messaging host), keeps the list of
// downloads, watches network responses for videos on each tab, and handles the
// right-click menu and keyboard shortcut. The popup only talks to this file.

const HOST_NAME = 'com.yoink.helper'
const IDLE_CLOSE_MS = 60_000
const MAX_HISTORY = 20
const MENU_ID = 'yoink-download'
const ACTIVE = ['queued', 'running', 'processing']

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
    if (ACTIVE.includes(job.status)) {
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

async function getSettings() {
  const {outDir, useLogins = true} = await chrome.storage.local.get(['outDir', 'useLogins'])
  return {outDir: outDir || undefined, useLogins}
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
      if (ACTIVE.includes(job.status)) {
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
    const busy = Object.values(state.jobs).some(j => ACTIVE.includes(j.status))
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
        finishJob(state.jobs[message.id], 'failed', {error: message.message})
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
  else if (message.type === 'done') return finishJob(job, 'done', {filepath: message.filepath})
  else if (message.type === 'failed') {
    return finishJob(job, message.cancelled ? 'cancelled' : 'failed', {error: message.message})
  }
  persistJobs()
  broadcast()
}

function finishJob(job, status, fields) {
  Object.assign(job, fields, {status})
  persistJobs()
  broadcast()
  if (status !== 'cancelled') void notify(job)
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

// --- Logged-in downloads ----------------------------------------------------
// The helper only gets cookies for the link being downloaded, and only when
// "Use my logins" is on. They never leave this computer.

async function cookiesFor(url) {
  if (!(await getSettings()).useLogins) return []
  try {
    const cookies = await chrome.cookies.getAll({url})
    return cookies.map(({name, value, domain, path, secure, httpOnly, expirationDate}) => ({
      name,
      value,
      domain,
      path,
      secure,
      httpOnly,
      expirationDate,
    }))
  } catch {
    return []
  }
}

async function cookieHeader(url) {
  return (await cookiesFor(url)).map(c => `${c.name}=${c.value}`).join('; ') || undefined
}

// --- Downloads --------------------------------------------------------------

async function analyze(url) {
  state.analyses[url] = {status: 'loading'}
  broadcast()
  try {
    await ensureHost()
    const data = await request({type: 'probe', url, cookies: await cookiesFor(url)}, message => {
      state.analyses[url] = {status: 'loading', message}
      broadcast()
    })
    state.analyses[url] = {status: 'ready', data}
  } catch (error) {
    state.analyses[url] = {status: 'error', error: error.message}
  }
  broadcast()
}

async function addJob(fields) {
  await ready
  const id = crypto.randomUUID()
  state.jobs[id] = {id, status: 'queued', createdAt: Date.now(), ...fields}
  persistJobs()
  broadcast()
  return state.jobs[id]
}

async function startDownload({url, probeId, choiceIndex, title, referer}) {
  const job = await addJob({url, title: title || url})
  try {
    const [{outDir}, cookies] = await Promise.all([getSettings(), cookiesFor(url), ensureHost()])
    connect().postMessage({type: 'download', id: job.id, url, probeId, choiceIndex, outDir, referer, cookies})
  } catch (error) {
    finishJob(job, 'failed', {error: error.message})
  }
}

async function startMerge({videoUrl, audioUrl, title, referer, totalBytes}) {
  const job = await addJob({url: videoUrl, title: title || videoUrl})
  try {
    const [{outDir}, videoCookie, audioCookie] = await Promise.all([
      getSettings(),
      cookieHeader(videoUrl),
      cookieHeader(audioUrl),
      ensureHost(),
    ])
    connect().postMessage({
      type: 'merge',
      id: job.id,
      videoUrl,
      audioUrl,
      title,
      outDir,
      referer,
      userAgent: navigator.userAgent,
      videoCookie,
      audioCookie,
      totalBytes,
    })
  } catch (error) {
    finishJob(job, 'failed', {error: error.message})
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
  const ext = /\.(mp4|webm|mov|m4v|mkv|ogv|m4a|mp3|opus|ogg)(?:$|\?)/i.exec(new URL(url).pathname + '?')?.[1]?.toLowerCase()
  const options = {url, saveAs: false}
  if (ext) options.filename = `${sanitizeFilename(title || 'video')}.${ext}`
  await chrome.downloads.download(options)
}

function forget(id) {
  delete state.jobs[id]
  persistJobs()
  broadcast()
}

// --- Notifications ----------------------------------------------------------
// Only when the popup is closed, so a right-click or shortcut download still
// says when it is done.

async function notify(job) {
  try {
    const open = await chrome.runtime.getContexts({contextTypes: ['POPUP']})
    if (open.length) return
    chrome.notifications.create(`job:${job.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: job.status === 'done' ? 'Saved' : 'Download failed',
      message: job.status === 'done' ? job.title : `${job.title}\n${job.error ?? ''}`.trim(),
      priority: 0,
    })
  } catch {
    // notifications are a nice-to-have
  }
}

chrome.notifications.onClicked.addListener(async notificationId => {
  const job = state.jobs[notificationId.replace(/^job:/, '')]
  chrome.notifications.clear(notificationId)
  if (job?.status !== 'done' || !job.filepath) return
  try {
    await ensureHost()
    port?.postMessage({type: 'reveal', filepath: job.filepath})
  } catch {
    // helper gone; nothing to show
  }
})

// --- Right-click menu and keyboard shortcut ---------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Download with Yoink',
      contexts: ['page', 'link', 'video', 'audio', 'frame'],
    })
  })
})

const isHttp = value => typeof value === 'string' && /^https?:\/\//i.test(value)

function quickDownload(tab, url) {
  if (!isHttp(url)) return
  void startDownload({url, title: tab?.title, referer: tab?.url})
  chrome.action.setBadgeText({tabId: tab?.id, text: '↓'}).catch(() => {})
  setTimeout(() => refreshBadge(tab?.id), 2500)
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  // Links win, then a real media address (not blob:), then the page itself.
  const url = [info.linkUrl, info.srcUrl, info.frameUrl, info.pageUrl].find(isHttp)
  quickDownload(tab, url)
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'download-page') return
  tab ??= (await chrome.tabs.query({active: true, currentWindow: true}))[0]
  quickDownload(tab, tab?.url)
})

// --- Popup messages ---------------------------------------------------------

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
    case 'merge':
      void startMerge(message)
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

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i
const AUDIO_EXT = /\.(m4a|mp3|opus|oga|ogg|weba)$/i
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|aac|vtt|srt)$/i
const SKIP_HOSTS = /(^|\.)(googlevideo\.com)$/i // that site streams in pieces: use "Find formats" on the page
const MIN_VIDEO_BYTES = 300 * 1024
const MIN_AUDIO_BYTES = 100 * 1024
const PAIR_WINDOW_MS = 1500 // a player asks for its video and audio tracks back to back
const MAX_ESTIMATES_PER_TAB = 6

/** tabId -> {items: Map(key -> item), variants: Set(url), estimates: number} */
const tabs = new Map()

function tabState(tabId) {
  let entry = tabs.get(tabId)
  if (!entry) tabs.set(tabId, (entry = {items: new Map(), variants: new Set(), estimates: 0}))
  return entry
}

/** Same file, different byte range: count it once. */
function itemKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const name of ['range', 'bytestart', 'byteend']) u.searchParams.delete(name)
    return u.href
  } catch {
    return url
  }
}

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
  const isVideo = !isManifest && (type.startsWith('video/') || VIDEO_EXT.test(parsed.pathname))
  const isAudio = !isManifest && !isVideo && (type.startsWith('audio/') || AUDIO_EXT.test(parsed.pathname))
  if (!isManifest && !isVideo && !isAudio) return undefined

  // A ranged response reports the whole file size after the slash.
  const range = /\/(\d+)$/.exec(header('content-range') ?? '')
  const size = Number(range?.[1] ?? header('content-length') ?? 0) || undefined
  if (!isManifest) {
    const min = isAudio ? MIN_AUDIO_BYTES : MIN_VIDEO_BYTES
    if (status !== 206 && size !== undefined && size < min) return undefined
    if (size === undefined && status === 206) return undefined
  }

  const kind = isManifest ? 'stream' : isAudio ? 'audio' : 'file'
  return {url, kind, size, type: type || undefined}
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0) return
    const item = classify(details.url, details.responseHeaders, details.statusCode)
    if (!item) return
    const key = itemKey(details.url)
    const tab = tabState(details.tabId)
    if (tab.items.has(key)) return
    item.foundAt = Date.now()
    item.hidden = tab.variants.has(key)
    tab.items.set(key, item)
    if (item.kind === 'file' || item.kind === 'audio') pairTracks(tab, item)
    const isHls = item.kind === 'stream' && (/\.m3u8$/i.test(new URL(item.url).pathname) || /mpegurl/.test(item.type ?? ''))
    if (isHls && !item.hidden && tab.estimates < MAX_ESTIMATES_PER_TAB) {
      tab.estimates++
      void estimateStream(details.tabId, key)
    }
    changed(details.tabId)
  },
  {urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other']},
  ['responseHeaders'],
)

/** A video file and an audio file seen close together are likely two halves of one video. */
function pairTracks(tab, item) {
  const want = item.kind === 'file' ? 'audio' : 'file'
  const partner = [...tab.items.values()]
    .filter(other => other.kind === want && !other.paired && Math.abs(other.foundAt - item.foundAt) <= PAIR_WINDOW_MS)
    .sort((a, b) => b.foundAt - a.foundAt)[0]
  if (!partner) return
  const video = item.kind === 'file' ? item : partner
  const audio = item.kind === 'audio' ? item : partner
  video.paired = audio.paired = true
  tab.items.set(`pair:${itemKey(video.url)}|${itemKey(audio.url)}`, {
    url: video.url,
    kind: 'pair',
    videoUrl: video.url,
    audioUrl: audio.url,
    size: video.size && audio.size ? video.size + audio.size : undefined,
    foundAt: item.foundAt,
  })
}

// --- Stream size estimates --------------------------------------------------
// A playlist file is tiny; the video behind it is not. Read the playlist, add
// up the segment lengths, and multiply by the bit rate (or by sampled segment sizes).

async function fetchText(url) {
  const response = await fetch(url, {credentials: 'include', signal: AbortSignal.timeout(8000)})
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

function parseMaster(text, base) {
  const variants = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue
    const bandwidth = Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1]) || undefined
    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1]) || undefined
    const uri = lines.slice(i + 1).find(next => next.trim() && !next.trim().startsWith('#'))
    if (uri) variants.push({url: new URL(uri.trim(), base).href, bandwidth, height})
  }
  return variants
}

function parseMedia(text, base) {
  let duration = 0
  const segments = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const seconds = /^#EXTINF:([\d.]+)/.exec(lines[i].trim())?.[1]
    if (!seconds) continue
    duration += Number(seconds)
    const uri = lines.slice(i + 1).find(next => next.trim() && !next.trim().startsWith('#'))
    if (uri) segments.push(new URL(uri.trim(), base).href)
  }
  return {duration, segments, ended: /#EXT-X-ENDLIST/.test(text)}
}

async function sampleSegments(segments) {
  const picks = [0, Math.floor(segments.length / 2), segments.length - 1].filter((v, i, all) => all.indexOf(v) === i)
  const sizes = await Promise.all(
    picks.map(async i => {
      try {
        const response = await fetch(segments[i], {method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(5000)})
        return Number(response.headers.get('content-length')) || 0
      } catch {
        return 0
      }
    }),
  )
  const known = sizes.filter(Boolean)
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * segments.length) : undefined
}

async function estimateStream(tabId, key) {
  const tab = tabs.get(tabId)
  const item = tab?.items.get(key)
  if (!item) return
  try {
    let mediaUrl = item.url
    let text = await fetchText(mediaUrl)
    let bandwidth
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const variants = parseMaster(text, mediaUrl)
      // The player also fetches the quality it plays; list the master only.
      for (const variant of variants) {
        const variantKey = itemKey(variant.url)
        tab.variants.add(variantKey)
        const known = tab.items.get(variantKey)
        if (known) known.hidden = true
      }
      const best = variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
      if (!best) return
      bandwidth = best.bandwidth
      item.height = best.height
      mediaUrl = best.url
      text = await fetchText(mediaUrl)
    }
    const {duration, segments, ended} = parseMedia(text, mediaUrl)
    item.duration = duration || undefined
    item.live = !ended
    if (ended) {
      item.size = bandwidth && duration ? Math.round((duration * bandwidth) / 8) : await sampleSegments(segments)
      item.estimated = item.size !== undefined
    }
  } catch {
    // no estimate; the row still works
  }
  if (tabs.get(tabId) === tab) changed(tabId)
}

// --- Per-tab bookkeeping ----------------------------------------------------

function visibleItems(tab) {
  const order = {pair: 0, file: 1, stream: 2, audio: 3}
  return [...(tab?.items.values() ?? [])]
    .filter(item => !item.hidden)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.foundAt - b.foundAt)
}

function refreshBadge(tabId) {
  if (tabId === undefined) return
  const count = visibleItems(tabs.get(tabId)).length
  chrome.action.setBadgeText({tabId, text: count ? String(count) : ''}).catch(() => {})
  chrome.action.setBadgeBackgroundColor({tabId, color: '#e0245e'}).catch(() => {})
}

function changed(tabId) {
  const tab = tabs.get(tabId)
  refreshBadge(tabId)
  void chrome.storage.session.set({
    [`detected:${tabId}`]: {items: [...(tab?.items ?? new Map()).entries()], variants: [...(tab?.variants ?? [])]},
  })
  chrome.runtime.sendMessage({type: 'detected', tabId, items: visibleItems(tab)}).catch(() => {})
}

async function getDetected(tabId) {
  if (!tabs.has(tabId)) {
    // The worker may have restarted since these were seen.
    const stored = (await chrome.storage.session.get(`detected:${tabId}`))[`detected:${tabId}`]
    if (stored?.items?.length) {
      tabs.set(tabId, {items: new Map(stored.items), variants: new Set(stored.variants), estimates: MAX_ESTIMATES_PER_TAB})
    }
  }
  return visibleItems(tabs.get(tabId))
}

function resetTab(tabId) {
  tabs.delete(tabId)
  void chrome.storage.session.remove(`detected:${tabId}`)
  chrome.action.setBadgeText({tabId, text: ''}).catch(() => {})
}

// A new page in the tab means the old list no longer applies.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) resetTab(tabId)
})
chrome.tabs.onRemoved.addListener(resetTab)
