function speechQueue (speech, texts, lang, index) {
  return new Promise((resolve, reject) => {
    if (texts.length === 0 || index >= texts.length) {
      resolve()
      return
    }

    const text = texts[index]

    speech(text, lang)
      .then(() => {
        speechQueue(speech, texts, lang, index + 1)
          .then(resolve)
          .catch(reject)
      })
      .catch(reject)
  })
}

export default {

  speech (text, lang) {
    return new Promise(async (resolve, reject) => {
      try {

        const response = await fetch(
          'http://xpparo9nqgtaxm8nakzhshla.93.127.212.66.sslip.io/v1/audio/speech',
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer Maria182512@',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              input: text,
              voice: 'pt-BR-ThalitaNeural'
            })
          }
        )

        if (!response.ok) {
          throw new Error('Erro ao gerar áudio TTS')
        }

        const blob = await response.blob()

        const audioUrl = URL.createObjectURL(blob)

        const audio = new Audio(audioUrl)

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl)
          resolve()
        }

        audio.onerror = (error) => {
          reject(error)
        }

        audio.play()

      } catch (error) {
        console.error('Erro no serviço de voz:', error)
        reject(error)
      }
    })
  },

  speechAll (texts, lang) {
    return speechQueue(this.speech, texts, lang, 0)
  }

}
