const timeoutMs = 15000

function clean (value) {
  return String(value == null ? '' : value).trim()
}

function buildText (message) {
  const data = message && message.$data ? message.$data : (message || {})
  const pronunciation = { E: 'É' }
  const prefix = clean(data.siglaSenha)
    .split('')
    .map(letter => pronunciation[letter.toUpperCase()] || letter)
    .join(', ')
  const number = clean(data.numeroSenha)
  const counter = clean(data.numeroLocal)
  const priority = Number(data.peso) > 0 ? ' Prioridade,' : ''
  return `Senha${priority} ${prefix}, ${number}, dirija-se ao guichê ${counter}`
}

function request (text) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeout = setTimeout(() => {
    if (controller) controller.abort()
  }, timeoutMs)

  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice: 'pt-BR-ThalitaNeural' }),
    signal: controller ? controller.signal : undefined
  })
    .then(response => {
      if (!response.ok) throw new Error(`TTS respondeu HTTP ${response.status}`)
      return response.blob()
    })
    .then(blob => {
      clearTimeout(timeout)
      const objectUrl = URL.createObjectURL(blob)
      const player = new Audio(objectUrl)
      player.preload = 'auto'
      return new Promise((resolve, reject) => {
        let settled = false
        const readyTimeout = setTimeout(() => finish(), 5000)
        const finish = error => {
          if (settled) return
          settled = true
          clearTimeout(readyTimeout)
          player.oncanplaythrough = null
          player.onerror = null
          if (error) {
            URL.revokeObjectURL(objectUrl)
            reject(error)
          } else {
            resolve({ objectUrl, player })
          }
        }
        player.oncanplaythrough = () => finish()
        player.onerror = () => finish(new Error('Não foi possível preparar o áudio do TTS'))
        player.load()
      })
    })
    .catch(error => {
      clearTimeout(timeout)
      throw error
    })
}

function play (prepared) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(prepared.objectUrl)
      error ? reject(error) : resolve()
    }

    prepared.player.onended = () => finish()
    prepared.player.onerror = () => finish(new Error('Falha ao reproduzir o áudio do TTS'))
    const playback = prepared.player.play()
    if (playback && typeof playback.catch === 'function') playback.catch(finish)
  })
}

export default {
  buildText,
  prepare (message) {
    return request(buildText(message))
  },
  play
}
