// Popup UI. All real work happens in background.js; this file draws state
// and sends it user actions. Text is always set with textContent so nothing
// from a web page is ever parsed as HTML.

const $ = selector => document.querySelector(selector)

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key === 'class') el.className = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    el.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return el
}

const send = message => chrome.runtime.sendMessage(message)

let snapshot = {host: {status: 'unknown'}, analyses: {}, jobs: {}}
let tab
let detected = []
let toastTimer

// --- Formatting ---------------------------------------------------------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
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

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return ''
  const s = Math.round(seconds)
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

function shortUrl(url) {
  try {
    const u = new URL(url)
    const file = u.pathname.split('/').filter(Boolean).at(-1) ?? ''
    return `${u.hostname}${file ? ` · ${decodeURIComponent(file)}` : ''}`
  } catch {
    return url
  }
}

function toast(message) {
  const el = $('#toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 2500)
}

// --- Rendering ---------------------------------------------------------------

function render() {
  renderHost()
  renderAnalysis()
  renderDetected()
  renderDownloads()
}

function renderHost() {
  const {status, error} = snapshot.host
  const badge = $('#host-badge')
  badge.className = 'badge'
  if (status === 'ready') {
    badge.textContent = 'helper ready'
    badge.classList.add('ok')
  } else if (status === 'missing') {
    badge.textContent = 'helper not installed'
    badge.classList.add('bad')
  } else if (status === 'connecting') {
    badge.textContent = 'connecting…'
  } else {
    badge.textContent = error ? 'helper problem' : 'checking…'
    if (error) badge.classList.add('bad')
  }

  $('#setup').hidden = status !== 'missing'
  $('#setup-error').textContent = status === 'missing' && error ? `Chrome said: ${error}` : ''
}

function renderAnalysis() {
  const box = $('#analysis')
  const url = $('#url').value.trim()
  const analysis = snapshot.analyses[url]
  box.hidden = !analysis
  box.replaceChildren()
  $('#find-btn').disabled = analysis?.status === 'loading'
  if (!analysis) return

  if (analysis.status === 'loading') {
    box.append(h('p', {class: 'muted'}, analysis.message || 'Looking for the video…'))
    return
  }
  if (analysis.status === 'error') {
    box.append(h('p', {class: 'error'}, analysis.error))
    return
  }

  const info = analysis.data
  const meta = [info.uploader, formatDuration(info.duration), info.site].filter(Boolean).join(' · ')
  box.append(
    h(
      'div',
      {class: 'preview'},
      info.thumbnail ? h('img', {src: info.thumbnail, alt: '', referrerpolicy: 'no-referrer'}) : undefined,
      h('div', {class: 'grow'}, h('div', {class: 'title'}, info.title), h('div', {class: 'sub'}, meta)),
    ),
    h(
      'div',
      {class: 'formats'},
      info.choices.map(choice =>
        h(
          'button',
          {
            class: 'format',
            type: 'button',
            onclick: async () => {
              await send({
                type: 'download',
                url,
                probeId: info.probeId,
                choiceIndex: choice.index,
                title: info.title,
                outDir: $('#outdir').value.trim() || undefined,
              })
              toast('Download started')
            },
          },
          h('span', {}, choice.label),
          h('span', {class: 'go'}, '↓'),
        ),
      ),
    ),
  )
}

function renderDetected() {
  const section = $('#detected-section')
  section.hidden = detected.length === 0
  $('#detected').replaceChildren(
    ...detected.map(item =>
      h(
        'li',
        {class: 'card row'},
        h(
          'div',
          {class: 'grow'},
          h('div', {class: 'title', title: item.url}, shortUrl(item.url)),
          h('div', {class: 'sub'}, [item.kind === 'stream' ? 'stream' : 'file', formatBytes(item.size)].filter(Boolean).join(' · ')),
        ),
        h('button', {class: 'ghost', type: 'button', onclick: () => downloadDetected(item)}, 'Download'),
      ),
    ),
  )
}

async function downloadDetected(item) {
  const title = tab?.title || shortUrl(item.url)
  if (item.kind === 'stream') {
    await send({
      type: 'download',
      url: item.url,
      title,
      referer: tab?.url,
      outDir: $('#outdir').value.trim() || undefined,
    })
    toast('Download started')
    return
  }
  const result = await send({type: 'downloadDirect', url: item.url, title})
  toast(result?.ok ? 'Sent to Chrome downloads' : `Could not start: ${result?.error ?? 'unknown error'}`)
}

function renderDownloads() {
  const jobs = Object.values(snapshot.jobs).sort((a, b) => b.createdAt - a.createdAt)
  $('#downloads-section').hidden = jobs.length === 0
  $('#downloads').replaceChildren(...jobs.map(jobRow))
}

function jobRow(job) {
  const active = job.status === 'queued' || job.status === 'running' || job.status === 'processing'
  const parts = job.totalParts || 1
  const fraction = job.totalBytes ? Math.min(1, ((job.part || 0) + job.downloadedBytes / job.totalBytes) / parts) : undefined

  let line
  if (job.status === 'queued') line = job.note || 'Starting…'
  else if (job.status === 'running') {
    line = [
      fraction === undefined ? formatBytes(job.downloadedBytes) : `${Math.round(fraction * 100)}%`,
      job.speed ? `${formatBytes(job.speed)}/s` : undefined,
      Number.isFinite(job.eta) ? `${formatDuration(job.eta)} left` : undefined,
    ]
      .filter(Boolean)
      .join(' · ')
  } else if (job.status === 'processing') line = 'Finishing up…'
  else if (job.status === 'done') line = 'Saved'
  else if (job.status === 'cancelled') line = 'Cancelled'
  else line = 'Failed'

  return h(
    'li',
    {class: 'card'},
    h(
      'div',
      {class: 'row'},
      h(
        'div',
        {class: 'grow'},
        h('div', {class: 'title', title: job.title}, job.title),
        h('div', {class: job.status === 'done' ? 'sub status-ok' : 'sub'}, line),
      ),
      active ? h('button', {class: 'ghost', type: 'button', onclick: () => send({type: 'cancel', id: job.id})}, 'Cancel') : undefined,
      job.status === 'done' && job.filepath
        ? h('button', {class: 'ghost', type: 'button', onclick: () => send({type: 'reveal', filepath: job.filepath})}, 'Show')
        : undefined,
      !active ? h('button', {class: 'ghost', type: 'button', title: 'Remove from list', onclick: () => send({type: 'forget', id: job.id})}, '✕') : undefined,
    ),
    active
      ? h('div', {class: fraction === undefined || job.status === 'processing' ? 'bar indeterminate' : 'bar'}, h('span', {style: `width:${Math.round((fraction ?? 0) * 100)}%`}))
      : undefined,
    job.status === 'failed' && job.error ? h('p', {class: 'error'}, job.error) : undefined,
  )
}

// --- Wiring ---------------------------------------------------------------

function setupCommand() {
  return /windows/i.test(navigator.userAgent)
    ? 'powershell -ExecutionPolicy Bypass -File scripts\\install.ps1'
    : './scripts/install.sh'
}

async function init() {
  $('#setup-cmd').textContent = setupCommand()
  $('#copy-cmd').addEventListener('click', async () => {
    await navigator.clipboard.writeText(setupCommand())
    toast('Copied')
  })
  $('#retry').addEventListener('click', () => {
    snapshot.host = {status: 'connecting'}
    renderHost()
    send({type: 'connect'})
  })

  $('#find').addEventListener('submit', event => {
    event.preventDefault()
    const url = $('#url').value.trim()
    if (url) send({type: 'analyze', url})
  })
  $('#url').addEventListener('input', renderAnalysis)

  const {outDir} = await chrome.storage.local.get('outDir')
  $('#outdir').value = outDir ?? ''
  $('#outdir').addEventListener('change', () => chrome.storage.local.set({outDir: $('#outdir').value.trim()}))

  ;[tab] = await chrome.tabs.query({active: true, currentWindow: true})
  if (tab?.url && /^https?:/.test(tab.url)) $('#url').value = tab.url
  if (tab?.id !== undefined) detected = (await send({type: 'getDetected', tabId: tab.id})) ?? []

  snapshot = (await send({type: 'getState'})) ?? snapshot
  render()
  send({type: 'connect'})
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'state') return
  snapshot = message.state
  render()
})

init()
