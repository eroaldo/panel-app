<template>
  <div class="novosga-default layout-content" :style="{ 'background-color': color('pageBgColor'), 'color': color('pageFontColor') }">
    <div class="columns is-gapless">
      <div class="column is-multiline featured-column">
        <header class="column media-stage">
          <video
            v-if="tvEnabled"
            ref="tvPlayer"
            class="panel-video"
            autoplay
            muted
            crossorigin="anonymous"
            @playing="tvStatus = ''"
            playsinline>
          </video>
          <div v-if="tvEnabled && tvStatus" class="tv-status">{{ tvStatus }}</div>
          <iframe
            v-else-if="videoEnabled && config.videoType === 'youtube' && youtubeEmbedUrl"
            ref="youtubeVideo"
            class="panel-video"
            :src="youtubeEmbedUrl"
            allow="autoplay; encrypted-media; picture-in-picture"
            @load="configureYoutubeVideo"
            frameborder="0">
          </iframe>
          <video
            v-else-if="videoEnabled && config.videoType === 'local' && config.videoUrl"
            class="panel-video"
            ref="localVideo"
            :src="config.videoUrl"
            autoplay
            loop
            playsinline
            @loadedmetadata="configureLocalVideo"
            :controls="!!config.videoControls">
          </video>
          <featured
            :message="lastMessage"
            v-if="lastMessage && !tvEnabled && !videoEnabled"
            :fontColor="color('featuredFontColor', 'pageFontColor')">
          </featured>
        </header>
        <footer class="column" :class="{ 'tv-footer': tvEnabled || videoEnabled }" :style="{ 'background-color': color('footerBgColor'), 'color': color('footerFontColor') }">
          <featured
            class="tv-call-footer"
            v-if="(tvEnabled || videoEnabled) && lastMessage"
            :message="lastMessage"
            :fontColor="color('featuredFontColor', 'pageFontColor')">
          </featured>
          <img v-if="!tvEnabled && !videoEnabled" :src="logoUrl" class="is-pulled-left">
          <h1 class="is-pulled-left" v-if="!tvEnabled && !videoEnabled && config.themeOptions.footerText" :style="{ 'color': color('footerFontColor') }">
            {{ config.themeOptions.footerText }}
          </h1>
        </footer>
      </div>
      <div class="column is-one-quarter history-column" :style="{ 'background-color': color('sidebarBgColor'), 'color': color('sidebarFontColor') }">
        <header>
          <h2 class="title" :style="{ 'color': color('sidebarFontColor') }">
            {{ 'history.title'|trans }}
          </h2>
          <history
            v-if="lastMessage"
            :messages="messages"
            :fontColorNormal="config.historyFontColorNormal || config.sidebarFontColorNormal"
            :fontColorPriority="config.historyFontColorPriority || config.sidebarFontColorPriority">
          </history>
        </header>
        <footer :style="{ 'background-color': color('clockBgColor'), 'color': color('clockFontColor') }">
          <clock :locale="config.locale" :dateFormat="'date_format'|trans" :fontColor="color('clockFontColor')"></clock>
        </footer>
      </div>
    </div>
  </div>
</template>

<script>
  import Clock from '@/components/Clock.vue'
  import Featured from '@/components/Featured.vue'
  import History from '@/components/History.vue'
  import audio from '@/services/audio'
  import speech from '@/services/speech'
  import externalTts from '@/services/external-tts'
  import Hls from 'hls.js'
  import mpegts from 'mpegts.js'

  export default {
    name: 'Default',
    components: {
      Clock,
      Featured,
      History
    },
    data () {
      return {
        isCalling: false,
        lastMessage: {},
        messageQueue: [],
        hls: null,
        tsPlayer: null,
        tvConfig: { volume: 15, defaultChannelId: '' },
        tvStatus: 'Carregando canal...'
      }
    },
    computed: {
      messages () {
        return this.$store.getters.history
      },
      message () {
        return this.$store.getters.message
      },
      config () {
        return this.$store.state.config
      },
      logoUrl () {
        return this.config.themeOptions.logo || 'static/images/logo.png'
      },
      videoEnabled () {
        return !!(this.config.theme === 'novosga.video' && this.config.videoUrl)
      },
      tvEnabled () {
        return this.config.theme === 'novosga.tv'
      },
      youtubeEmbedUrl () {
        if (!this.config.videoUrl) return ''
        const value = this.config.videoUrl.trim()
        const match = value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^?&/]+)/)
        if (!match) return ''
        const id = match[1]
        return `https://www.youtube.com/embed/${id}?autoplay=1&mute=0&loop=1&playlist=${id}&controls=${this.config.videoControls ? 1 : 0}&rel=0&enablejsapi=1`
      }
    },
    methods: {
      loadTv () {
        this.tvStatus = 'Carregando canal...'
        Promise.all([
          fetch('/api/tv/config').then(response => response.json()),
          fetch('/api/tv/channels').then(response => response.json())
        ]).then(([config, result]) => {
          this.tvConfig = config
          const channels = result.channels || []
          const selected = channels.find(channel => channel.id === config.defaultChannelId) || channels[0]
          if (selected) this.playTvChannel(selected.id)
        }).catch(error => {
          this.tvStatus = 'Não foi possível carregar o canal'
          console.error('Falha ao carregar lista de TV', error)
        })
      },
      playTvChannel (channelId) {
        const video = this.$refs.tvPlayer
        if (!video) return
        if (this.hls) {
          this.hls.destroy()
          this.hls = null
        }
        if (this.tsPlayer) {
          this.tsPlayer.destroy()
          this.tsPlayer = null
        }
        fetch(`/api/tv/source/${channelId}`)
          .then(response => response.json().then(body => ({ response, body })))
          .then(({ response, body }) => {
            if (!response.ok) throw new Error(body.error || 'Canal indisponível')
            this.attachTvSource(video, body.url)
          })
          .catch(error => {
            this.tvStatus = 'Canal indisponível'
            console.error('Falha ao abrir canal de TV', error)
          })
      },
      attachTvSource (video, source) {
        const tsSource = source.replace(/\.m3u8(?=($|\?))/i, '.ts')
        if (mpegts.isSupported()) {
          this.tvStatus = 'Carregando canal...'
          this.tsPlayer = mpegts.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: tsSource,
            cors: true
          }, {
            enableWorker: false,
            lazyLoad: false,
            enableStashBuffer: true,
            stashInitialSize: 2097152,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 60,
            autoCleanupMinBackwardDuration: 30,
            liveBufferLatencyChasing: false,
            reuseRedirectedURL: true,
            fixAudioTimestampGap: true
          })
          this.tsPlayer.attachMediaElement(video)
          video.onloadedmetadata = () => this.startTvPlayback(video)
          video.oncanplay = () => this.startTvPlayback(video)
          this.tsPlayer.on(mpegts.Events.MEDIA_INFO, () => this.startTvPlayback(video))
          this.tsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
            this.tvStatus = `Falha no canal: ${type || 'erro'} / ${detail || 'desconhecido'}`
            console.error('Falha no fluxo MPEG-TS', type, detail, info)
          })
          this.tsPlayer.load()
          return
        }
        if (Hls.isSupported()) {
          this.hls = new Hls({ enableWorker: true, lowLatencyMode: true })
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => this.startTvPlayback(video))
          this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (!data.fatal) return
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              this.tvStatus = 'Canal indisponivel na lista'
              this.hls.stopLoad()
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              this.tvStatus = 'Recuperando reprodução...'
              this.hls.recoverMediaError()
            } else {
              this.tvStatus = 'Canal temporariamente indisponível'
            }
          })
          this.hls.attachMedia(video)
          this.hls.loadSource(source)
        } else {
          video.src = source
          video.onloadedmetadata = () => this.startTvPlayback(video)
        }
      },
      startTvPlayback (video) {
        video.volume = Math.max(0, Math.min(1, Number(this.tvConfig.volume || 15) / 100))
        video.muted = true
        const playback = video.play()
        if (playback && typeof playback.then === 'function') {
          playback.then(() => {
            video.muted = false
            const audiblePlayback = video.play()
            if (audiblePlayback && typeof audiblePlayback.catch === 'function') {
              audiblePlayback.catch(() => { video.muted = true })
            }
          }).catch(() => {
            video.muted = true
            video.play()
          })
        }
      },
      configureLocalVideo () {
        const video = this.$refs.localVideo
        if (!video) return
        video.volume = Math.max(0, Math.min(1, Number(this.config.videoVolume || 15) / 100))
        video.muted = false
        const playback = video.play()
        if (playback && typeof playback.catch === 'function') {
          playback.catch(() => {
            video.muted = true
            video.play()
          })
        }
      },
      configureYoutubeVideo () {
        const frame = this.$refs.youtubeVideo
        if (!frame || !frame.contentWindow) return
        const command = (func, args) => {
          frame.contentWindow.postMessage(JSON.stringify({
            event: 'command',
            func,
            args: args || []
          }), 'https://www.youtube.com')
        }
        setTimeout(() => {
          command('setVolume', [Number(this.config.videoVolume || 15)])
          command('unMute')
          command('playVideo')
        }, 1000)
      },
      call () {
        this.messageQueue.push(this.message)
        if (!this.isCalling) {
          this.playAudio()
        }
      },
      playAudio () {
        if (this.isCalling || this.messageQueue.length === 0) {
          return
        }
        this.isCalling = true
        this.lastMessage = this.messageQueue.shift()
        const calledMessage = this.lastMessage
        const preparedVoice = this.config.speech
          ? externalTts.prepare(calledMessage).catch(() => null)
          : Promise.resolve(null)

        preparedVoice
          .then(prepared => {
            return audio.playAlert(this.config.alert).then(() => prepared)
          })
          .then(prepared => {
            if (!this.config.speech) return Promise.resolve()
            if (prepared) return externalTts.play(prepared)

            const data = calledMessage.$data || calledMessage
            const texts = ['Senha']
            if (Number(data.peso) > 0) texts.push('Prioridade')
            data.siglaSenha.split('').forEach(char => texts.push(char))
            texts.push(data.numeroSenha)
            texts.push('dirija-se ao guichê')
            texts.push(data.numeroLocal)
            return speech.speechAll(texts, this.config.locale)
          })
          .catch(error => console.error('Falha ao reproduzir chamada', error))
          .then(() => {
            this.isCalling = false
            this.playAudio()
          })
      },
      color (prefix, fallback) {
        const peso = this.lastMessage.$data ? this.lastMessage.$data.peso : 0
        const suffix = peso > 0 ? 'Priority' : 'Normal'
        return this.config[prefix + suffix] || this.config[fallback + suffix]
      }
    },
    watch: {
      message () {
        this.call()
      }
    },
    mounted () {
      if (this.tvEnabled) this.$nextTick(() => this.loadTv())
    },
    beforeDestroy () {
      if (this.hls) this.hls.destroy()
      if (this.tsPlayer) this.tsPlayer.destroy()
    }
  }
</script>

<style lang="sass">
  .novosga-default
    .layout-content
      position: fixed
      width: 100%
      height: 100%
      .columns
        height: 100%

    .clock
      .time
        span
          font-size: 4vw
        span.hours
          font-weight: bold
        span.seconds
          font-style: italic
      .date
        text-align: center
        span
          font-size: 2vw
          font-weight: bold

    .featured-column
        >header
          height: 80vh
        >footer
          height: 20vh
          padding: 5vh
          &.tv-footer
            padding: 0
          img
            height: 10vh
          h1
            font-size: 5vh
            padding: 2vh 0 0 5vh
          .tv-call-footer
            height: 100%
            display: flex
            align-items: center
            justify-content: space-evenly
            text-align: center
            padding: 0 2vw
            .title
              font-size: 14vh
              line-height: 14vh
              font-weight: bold
              margin: 0 2vw
            .subtitle
              font-size: 7vh
              line-height: 7vh
              margin: 0 2vw
            .description
              font-size: 4vh
              margin: 0 1vw
        .featured-message
          text-align: center
          .title
            font-size: 30vh
            font-weight: bold
          .subtitle
            font-size: 10vh
          .description
            font-size: 10vh

        .media-stage
          position: relative
          overflow: hidden
          padding: 0
          .panel-video
            position: absolute
            width: 100%
            height: 100%
            top: 0
            left: 0
            object-fit: cover
            border: 0
          .tv-status
            position: absolute
            inset: 0
            z-index: 1
            display: flex
            align-items: center
            justify-content: center
            background: #111
            color: #fff
            font-size: 4vh
          .featured-overlay
            position: absolute
            left: 4%
            right: 4%
            bottom: 4%
            z-index: 2
            padding: 1.5vh 2vw
            border-radius: 1rem
            background: rgba(255, 255, 255, .90)
            box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, .35)
            .title
              font-size: 16vh
            .subtitle, .description
              font-size: 5vh

    .history-column
      height: 100vh
      >header
        height: 80vh
        padding: 1rem 0
      >footer
        height: 20vh
        padding: 1rem 0
        text-align: center
        background: rgba(0,0,0,.1)
      *
        color: #2c3e50
      .title
        text-align: center
        font-weight: bold
      .message
        background-color: transparent
        border-left: 8px solid rgba(0,0,0,.3)
        padding-left: 2rem
        margin-bottom: 1rem
      .empty
        p
          font-style: italic
          text-align: center
      .history
        .message
          span
            text-align: left
            display: block
          .title
            font-size: 8vh
            font-weight: bold
          .subtitle
            font-size: 4vh
            font-style: italic
</style>
