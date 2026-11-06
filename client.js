/**
 * System notifications — Web page.
 *
 * Holds `/dsh-system-notify/events` open and raises a browser notification for
 * every frame. The shell turns that into a native notification carrying the
 * DeepSeek Harness icon, which the Host's `osascript` fallback cannot do: that
 * one belongs to the helper process, so macOS draws a generic script icon.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-system-notify',
  factory() {
    const PATH = '/dsh-system-notify/events'
    const RECONNECT_MIN_MS = 1_000
    const RECONNECT_MAX_MS = 30_000

    return {
      name: 'dsh-system-notify-client',
      inject: ['uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof window === 'undefined' || typeof Notification === 'undefined') return undefined
          let disposed = false
          let controller
          let timer
          let delay = RECONNECT_MIN_MS

          /**
           * Raise one notification for a Host frame.
           * @param {object} payload - `{ title, subtitle, body, sound, sessionId }`.
           */
          const show = (payload) => {
            try {
              if (Notification.permission === 'default') void Notification.requestPermission()
              if (Notification.permission !== 'granted') return
              const parts = [payload.subtitle, payload.body]
                .filter(part => typeof part === 'string' && part !== '')
              const title = typeof payload.title === 'string' && payload.title !== ''
                ? payload.title
                : 'DeepSeek Harness'
              const notification = new Notification(title, {
                body: parts.join('：'),
                silent: payload.sound === false,
              })
              notification.onclick = () => {
                window.focus()
                if (typeof payload.sessionId === 'string' && payload.sessionId !== '') {
                  try {
                    ctx.uiWorkspace.openSession(payload.sessionId)
                  } catch {
                    // A Session from another workspace still just focuses.
                  }
                }
                notification.close()
              }
            } catch {
              // A rejected notification must never disturb the page.
            }
          }

          /**
           * Consume the event stream until it closes, then reconnect.
           */
          const connect = async () => {
            controller = new AbortController()
            let connected = false
            try {
              // Ask first and wait: the capability claim below must describe the
              // permission this page ends up with, not the one it started with.
              if (Notification.permission === 'default') {
                try { await Notification.requestPermission() } catch { /* keep 'default' */ }
              }
              // The Host counts only a page that can actually raise
              // notifications, and falls back to the platform notifier
              // otherwise instead of going silent.
              const url = `${PATH}?notify=${encodeURIComponent(Notification.permission)}`
              const response = await fetch(url, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { accept: 'text/event-stream' },
              })
              if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
              connected = true
              delay = RECONNECT_MIN_MS
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              let buffer = ''
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let boundary = buffer.indexOf('\n\n')
                while (boundary >= 0) {
                  const frame = buffer.slice(0, boundary)
                  buffer = buffer.slice(boundary + 2)
                  for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue
                    try {
                      show(JSON.parse(line.slice(5).trim()))
                    } catch {
                      // One malformed frame does not close the stream.
                    }
                  }
                  boundary = buffer.indexOf('\n\n')
                }
              }
            } catch {
              // Aborts on disposal and transport errors both land here.
            }
            if (disposed) return
            if (!connected) delay = Math.min(delay * 2, RECONNECT_MAX_MS)
            timer = window.setTimeout(() => { void connect() }, delay)
          }

          void connect()
          return () => {
            disposed = true
            controller?.abort()
            if (timer !== undefined) window.clearTimeout(timer)
          }
        }, 'dsh-system-notify: event stream')
      },
    }
  },
})
