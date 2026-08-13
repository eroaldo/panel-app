const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')

const port = 8787
const configPath = process.env.TTS_CONFIG_PATH || '/config/tts.json'
const tvConfigPath = process.env.TV_CONFIG_PATH || '/config/tv.json'
const tvPlaylistCachePath = process.env.TV_PLAYLIST_CACHE_PATH || '/config/playlist.m3u'
const adminPassword = process.env.TTS_ADMIN_PASSWORD || ''
const maxBodyBytes = 32 * 1024
const channelCache = { loadedAt: 0, channels: [], byId: new Map() }
const mediaUrls = new Map()

function json (response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

function loadConfig () {
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!value.endpoint || !value.token || !value.voice) throw new Error('Configuração TTS incompleta')
  value.speed = normalizeSpeed(value.speed)
  return value
}

function normalizeSpeed (value) {
  const speed = Number(value == null ? 1 : value)
  if (!Number.isFinite(speed)) return 1
  return Math.max(0.5, Math.min(2, speed))
}

function readBody (request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(new Error('Corpo da requisição muito grande'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(new Error('JSON inválido'))
      }
    })
    request.on('error', reject)
  })
}

function saveConfig (config) {
  const directory = path.dirname(configPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${configPath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, configPath)
  fs.chmodSync(configPath, 0o600)
}

function loadTvConfig () {
  if (!fs.existsSync(tvConfigPath)) return { playlistUrl: '', defaultChannelId: '', volume: 15 }
  return JSON.parse(fs.readFileSync(tvConfigPath, 'utf8'))
}

function saveTvConfig (config) {
  const directory = path.dirname(tvConfigPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${tvConfigPath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, tvConfigPath)
  fs.chmodSync(tvConfigPath, 0o600)
}

function parseAttributes (line) {
  const attributes = {}
  const pattern = /([\w-]+)="([^"]*)"/g
  let match
  while ((match = pattern.exec(line))) attributes[match[1]] = match[2]
  return attributes
}

async function loadChannels (force) {
  const config = loadTvConfig()
  if (!config.playlistUrl) throw new Error('Lista M3U não configurada')
  if (!force && channelCache.channels.length && Date.now() - channelCache.loadedAt < 300000) {
    return channelCache.channels
  }

  let text
  try {
    const response = await fetch(config.playlistUrl, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Lista M3U respondeu HTTP ${response.status}`)
    text = await response.text()
    fs.writeFileSync(tvPlaylistCachePath, text, { mode: 0o600 })
    fs.chmodSync(tvPlaylistCachePath, 0o600)
  } catch (error) {
    if (!fs.existsSync(tvPlaylistCachePath)) throw error
    console.warn(`Usando cache local da lista M3U: ${error.message}`)
    text = fs.readFileSync(tvPlaylistCachePath, 'utf8')
  }
  const lines = text.split(/\r?\n/)
  const channels = []
  const byId = new Map()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('#EXTINF:')) continue
    const url = (lines[index + 1] || '').trim()
    if (!url || url.startsWith('#')) continue
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (_) {
      continue
    }
    if (!parsedUrl.pathname.toLowerCase().includes('/live/')) continue
    const attributes = parseAttributes(line)
    const name = line.includes(',') ? line.substring(line.lastIndexOf(',') + 1).trim() : `Canal ${channels.length + 1}`
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 20)
    const channel = {
      id,
      name,
      logo: attributes['tvg-logo'] || '',
      group: attributes['group-title'] || ''
    }
    channels.push(channel)
    byId.set(id, url)
    index += 1
  }

  channelCache.loadedAt = Date.now()
  channelCache.channels = channels
  channelCache.byId = byId
  return channels
}

function mediaToken (url) {
  const token = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)
  mediaUrls.set(token, url)
  return token
}

function rewriteManifest (manifest, baseUrl) {
  return manifest.split(/\r?\n/).map(line => {
    if (!line) return line
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, value) => {
        const url = new URL(value, baseUrl).toString()
        return `URI="/api/tv/proxy/${mediaToken(url)}"`
      })
    }
    const url = new URL(line.trim(), baseUrl).toString()
    return `/api/tv/proxy/${mediaToken(url)}`
  }).join('\n')
}

async function proxyMedia (url, request, response) {
  const headers = {}
  if (request.headers.range) headers.Range = request.headers.range
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  const upstream = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
  clearTimeout(timeout)
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const isManifest = contentType.includes('mpegurl') || url.toLowerCase().includes('.m3u8')

  if (isManifest) {
    const manifest = await upstream.text()
    const rewritten = rewriteManifest(manifest, upstream.url || url)
    response.writeHead(upstream.status, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store'
    })
    return response.end(rewritten)
  }

  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  }
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders[name] = value
  }
  response.writeHead(upstream.status, responseHeaders)
  if (!upstream.body) return response.end()
  Readable.fromWeb(upstream.body).pipe(response)
}

async function updateTvConfig (request, response) {
  if (!adminPassword || request.headers['x-admin-password'] !== adminPassword) {
    return json(response, 401, { error: 'Senha administrativa inválida' })
  }
  const current = loadTvConfig()
  const body = await readBody(request)
  const playlistUrl = String(body.playlistUrl || '').trim() || current.playlistUrl
  const defaultChannelId = String(body.defaultChannelId || '').trim()
  const volume = Math.max(0, Math.min(100, Number(body.volume == null ? current.volume : body.volume)))
  try {
    const parsed = new URL(playlistUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol')
  } catch (_) {
    return json(response, 400, { error: 'URL da lista M3U inválida' })
  }
  saveTvConfig({ playlistUrl, defaultChannelId, volume })
  channelCache.loadedAt = 0
  channelCache.channels = []
  channelCache.byId = new Map()
  mediaUrls.clear()
  return json(response, 200, { hasPlaylist: true, defaultChannelId, volume })
}

async function updateConfig (request, response) {
  if (!adminPassword || request.headers['x-admin-password'] !== adminPassword) {
    return json(response, 401, { error: 'Senha administrativa inválida' })
  }

  const current = loadConfig()
  const body = await readBody(request)
  const endpoint = String(body.endpoint || '').trim()
  const voice = String(body.voice || '').trim()
  const token = String(body.token || '').trim() || current.token
  const speed = normalizeSpeed(body.speed == null ? current.speed : body.speed)

  let parsed
  try {
    parsed = new URL(endpoint)
  } catch (_) {
    return json(response, 400, { error: 'URL do TTS inválida' })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return json(response, 400, { error: 'A URL deve usar HTTP ou HTTPS' })
  }
  if (!voice || !token) return json(response, 400, { error: 'Voz e token são obrigatórios' })

  saveConfig({ endpoint, voice, token, speed })
  return json(response, 200, { endpoint, voice, speed, hasToken: true })
}

async function speech (request, response) {
  const config = loadConfig()
  const body = await readBody(request)
  const input = String(body.input || '').trim()
  if (!input) return json(response, 400, { error: 'Texto da locução vazio' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const upstream = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input, voice: config.voice, speed: config.speed }),
      signal: controller.signal
    })
    const audio = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store'
    })
    response.end(audio)
  } finally {
    clearTimeout(timeout)
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true })
    if (request.method === 'GET' && request.url === '/config') {
      const config = loadConfig()
      return json(response, 200, { endpoint: config.endpoint, voice: config.voice, speed: config.speed, hasToken: !!config.token })
    }
    if (request.method === 'PUT' && request.url === '/config') return await updateConfig(request, response)
    if (request.method === 'POST' && request.url === '/speech') return await speech(request, response)
    if (request.method === 'GET' && request.url === '/tv/config') {
      const config = loadTvConfig()
      return json(response, 200, {
        hasPlaylist: !!config.playlistUrl,
        defaultChannelId: config.defaultChannelId || '',
        volume: Number(config.volume == null ? 15 : config.volume)
      })
    }
    if (request.method === 'PUT' && request.url === '/tv/config') return await updateTvConfig(request, response)
    if (request.method === 'GET' && request.url.startsWith('/tv/channels')) {
      const channels = await loadChannels(request.url.includes('refresh=1'))
      return json(response, 200, { channels })
    }
    if (request.method === 'GET' && request.url.startsWith('/tv/source/')) {
      if (!channelCache.channels.length) await loadChannels(false)
      const id = request.url.substring('/tv/source/'.length).split('?')[0]
      const value = channelCache.byId.get(id)
      if (!value) return json(response, 404, { error: 'Canal não encontrado' })
      const url = new URL(value)
      url.protocol = 'https:'
      url.port = ''
      const tsUrl = new URL(url.toString().replace(/\.m3u8(?=($|\?))/i, '.ts'))
      try {
        const upstream = await fetch(tsUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15000)
        })
        const location = upstream.headers.get('location')
        if (location) {
          const resolved = new URL(location, tsUrl)
          resolved.protocol = 'https:'
          resolved.port = ''
          return json(response, 200, { url: resolved.toString() })
        }
      } catch (error) {
        console.error('Falha ao resolver redirecionamento seguro do canal', error.message)
      }
      return json(response, 200, { url: tsUrl.toString() })
    }
    if (request.method === 'GET' && request.url.startsWith('/tv/stream/')) {
      if (!channelCache.channels.length) await loadChannels(false)
      const id = request.url.substring('/tv/stream/'.length).split('?')[0]
      const url = channelCache.byId.get(id)
      if (!url) return json(response, 404, { error: 'Canal não encontrado' })
      return await proxyMedia(url, request, response)
    }
    if (request.method === 'GET' && request.url.startsWith('/tv/proxy/')) {
      const token = request.url.substring('/tv/proxy/'.length).split('?')[0]
      const url = mediaUrls.get(token)
      if (!url) return json(response, 404, { error: 'Segmento não encontrado' })
      return await proxyMedia(url, request, response)
    }
    return json(response, 404, { error: 'Endpoint não encontrado' })
  } catch (error) {
    console.error(error)
    return json(response, 500, { error: 'Falha interna no serviço TTS' })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`TTS config service listening on ${port}`))
