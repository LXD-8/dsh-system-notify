/**
 * System notifications — Host half.
 *
 * Turns three things the Host already knows into operating-system
 * notifications, so a user who switched to another application learns when
 * work finished or when the agent is blocked on them:
 *
 *   - `turn/end` with reason `completed` — the task finished.
 *   - `turn/end` with reason `max-tokens` — the task stopped at the output limit.
 *   - `turn/end` with reason `error`     — the task failed.
 *   - `user-questions/request`           — the agent asks a question.
 *   - `approval/request`                 — a tool waits for permission.
 *
 * Both request waterfalls are observed without claiming: the listener calls
 * `next()` and returns its answer unchanged. A request only notifies when it
 * is still unanswered after a short grace period, so an answerer that resolves
 * immediately (an auto-approving policy, or a user who is already reading the
 * prompt) stays silent.
 *
 * Delivery prefers the connected Web page, which raises a browser notification
 * that macOS attributes to DeepSeek Harness and draws with the application
 * icon. The page subscribes to `/dsh-system-notify/events` (Server-Sent
 * Events) and claims `?notify=granted` only when it can actually notify.
 *
 * Without a notifying page the plugin falls back to a platform command:
 *   macOS   `osascript` `display notification`
 *   Linux   `notify-send`
 * That fallback works headless, but the operating system attributes it to the
 * helper process, so macOS draws a generic script icon instead of the
 * application's.
 *
 * macOS additionally suppresses the notification while DeepSeek Harness is the
 * frontmost application, because a user watching the conversation does not
 * need to be told what just happened on screen.
 */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export const name = 'dsh-system-notify'
export const inject = ['sessions']

/**
 * Optional Loader schema: the vendored schemastery package exists in a source
 * checkout only. Without it the plugin still runs on the defaults below and
 * accepts the same keys from `cordis.patch.yml`.
 */
let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')
  Config = z.object({
    turnComplete: z.boolean().default(true),
    turnError: z.boolean().default(true),
    turnMaxTokens: z.boolean().default(true),
    userQuestion: z.boolean().default(true),
    approval: z.boolean().default(true),
    subagents: z.boolean().default(false),
    sound: z.boolean().default(true),
    skipWhenForeground: z.boolean().default(true),
    foregroundApps: z.array(z.string()).default(['DeepSeek Harness', 'Electron']),
    requestGraceMs: z.number().min(0).default(1200),
  })
} catch {
  // No source checkout: defaults plus runtime coercion only.
}
export { Config }

/** Effective defaults, applied with or without a projected Config schema. */
const DEFAULTS = {
  turnComplete: true,
  turnError: true,
  turnMaxTokens: true,
  userQuestion: true,
  approval: true,
  subagents: false,
  sound: true,
  skipWhenForeground: true,
  foregroundApps: ['DeepSeek Harness', 'Electron'],
  requestGraceMs: 1200,
}

const APP_TITLE = 'DeepSeek Harness'
/** Server-Sent Events route the Web page subscribes to. */
const EVENT_STREAM_PATH = '/dsh-system-notify/events'
/** Read-only route reporting whether a page is connected. */
const STATUS_PATH = '/dsh-system-notify/status'
/** Manual check route that raises one sample notification. */
const TEST_PATH = '/dsh-system-notify/test'
/** Comment frames keep idle proxies from closing the stream. */
const HEARTBEAT_MS = 20_000
const BODY_LIMIT = 160
const SUBTITLE_LIMIT = 60
const EXEC_TIMEOUT_MS = 4_000
const FRONT_TIMEOUT_MS = 1_500
/** Events scanned back from `turn/end` when looking for the closing answer. */
const TAIL_SCAN = 8

/**
 * Merge untrusted Loader config over the defaults, dropping wrong types.
 * @param {unknown} raw - the row's `config`, possibly absent or unvalidated.
 * @returns the effective notification settings.
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }
  for (const key of ['turnComplete', 'turnError', 'turnMaxTokens', 'userQuestion', 'approval', 'subagents', 'sound', 'skipWhenForeground']) {
    if (typeof input[key] === 'boolean') config[key] = input[key]
  }
  if (Array.isArray(input.foregroundApps)) {
    const apps = input.foregroundApps.filter(app => typeof app === 'string' && app.length > 0)
    if (apps.length > 0) config.foregroundApps = apps
  }
  if (typeof input.requestGraceMs === 'number' && Number.isFinite(input.requestGraceMs) && input.requestGraceMs >= 0) {
    config.requestGraceMs = input.requestGraceMs
  }
  return config
}

/**
 * Collapse text to one line and cap it, so a notification body stays readable.
 * @param {unknown} value - candidate text.
 * @param {number} limit - maximum characters.
 * @returns the normalized text, or an empty string.
 */
function compact(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

/**
 * Quote one string for an AppleScript string literal.
 * @param {string} text - already-compacted text.
 * @returns the escaped literal body.
 */
function appleScriptString(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Report one shell failure without letting a notification break the turn.
 * @param {string} stage - what was being attempted.
 * @param {unknown} error - the failure.
 * @param {object} ctx - plugin context carrying the optional logger.
 */
function warn(ctx, stage, error) {
  const reason = error instanceof Error ? error.message : String(error)
  try {
    ctx.logger.warn(`system-notify: ${stage} failed: ${reason}`)
  } catch {
    // A broken log sink must never fail a notification.
  }
}

/**
 * Read the frontmost application name on macOS.
 * @returns the application name, or `undefined` when unavailable.
 */
function frontmostApp() {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['front'], { timeout: FRONT_TIMEOUT_MS }, (frontError, frontOut) => {
      const asn = String(frontOut ?? '').trim()
      if (frontError || asn === '') { resolve(undefined); return }
      execFile('lsappinfo', ['info', '-only', 'name', asn], { timeout: FRONT_TIMEOUT_MS }, (infoError, infoOut) => {
        if (infoError) { resolve(undefined); return }
        const match = /"([^"]+)"/.exec(String(infoOut ?? ''))
        resolve(match ? match[1] : undefined)
      })
    })
  })
}

/**
 * Decide whether the user is already looking at Harness.
 * @param {object} config - effective settings.
 * @returns true when the notification should be suppressed.
 */
async function isForeground(config) {
  if (!config.skipWhenForeground || process.platform !== 'darwin') return false
  const name = await frontmostApp()
  // An unreadable frontmost application fails open: a late notification is
  // better than a missing one.
  if (name === undefined) return false
  const current = name.toLowerCase()
  return config.foregroundApps.some(app => current.includes(app.toLowerCase()))
}

/**
 * Deliver one notification through the platform's own command.
 *
 * This is the fallback used when no Harness page is connected: the operating
 * system attributes such a notification to the helper process that posted it,
 * so macOS shows a generic script icon instead of the application's own.
 *
 * @param {object} ctx - plugin context, for diagnostics only.
 * @param {object} config - effective settings.
 * @param {{ title: string, subtitle: string, body: string, sound: boolean }} payload - content.
 */
function platformNotify(ctx, config, payload) {
  // Other platforms have no dependency-free notifier; the plugin stays
  // installed and silent rather than pulling in a native module.
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  try {
    if (process.platform === 'darwin') {
      const script = [
        `display notification "${appleScriptString(payload.body)}" with title "${appleScriptString(payload.title)}"`,
        payload.subtitle === '' ? '' : ` subtitle "${appleScriptString(payload.subtitle)}"`,
        payload.sound ? ' sound name "Glass"' : '',
      ].join('')
      execFile('osascript', ['-e', script], { timeout: EXEC_TIMEOUT_MS }, (error) => {
        if (error) warn(ctx, 'osascript', error)
      })
      return
    }
    const args = ['--app-name', APP_TITLE, payload.subtitle === '' ? payload.title : `${payload.title} · ${payload.subtitle}`, payload.body]
    if (payload.sound) args.unshift('--hint=string:sound-name:message-new-instant')
    execFile('notify-send', args, { timeout: EXEC_TIMEOUT_MS }, (error) => {
      if (error) warn(ctx, 'notify-send', error)
    })
  } catch (error) {
    warn(ctx, 'delivery', error)
  }
}

/**
 * Send one notification to every connected Harness page.
 *
 * The page shows it with the browser Notification API, so the operating system
 * attributes it to DeepSeek Harness and draws the application icon. A page that
 * cannot raise notifications (a browser without permission) is not counted, so
 * the caller falls back to the platform notifier instead of going silent.
 *
 * @param {Map<object, boolean>} clients - open event-stream responses and whether they can notify.
 * @param {{ title: string, subtitle: string, body: string, sound: boolean }} payload - content.
 * @returns true when at least one notifying page received it.
 */
function broadcast(clients, payload) {
  if (clients.size === 0) return false
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  let delivered = false
  for (const [res, canNotify] of [...clients]) {
    if (res.writableEnded === true || res.destroyed === true) { clients.delete(res); continue }
    try {
      res.write(frame)
      if (canNotify === true) delivered = true
    } catch {
      clients.delete(res)
    }
  }
  return delivered
}

/**
 * Compose the wire payload and deliver it to a page when one is connected,
 * otherwise through the platform notifier.
 * @param {object} ctx - plugin context, for diagnostics only.
 * @param {object} config - effective settings.
 * @param {Map<object, boolean>} clients - open event-stream responses.
 * @param {{ title: string, subtitle?: string, body: string, sessionId?: string }} message - content.
 */
async function deliver(ctx, config, clients, message) {
  if (await isForeground(config)) return
  const payload = {
    title: compact(message.title, SUBTITLE_LIMIT) || APP_TITLE,
    subtitle: compact(message.subtitle, SUBTITLE_LIMIT),
    body: compact(message.body, BODY_LIMIT) || ' ',
    sound: config.sound,
    sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
  }
  if (!broadcast(clients, payload)) platformNotify(ctx, config, payload)
}

/**
 * Strip the port and IPv6 brackets from a Host header.
 * @param {string} host - the raw `host` header.
 * @returns the bare host name.
 */
function hostName(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(1, end)
  }
  return host.split(':')[0]
}

/**
 * Whether one request may reach a plugin route: same origin, and a Host that
 * is this machine rather than a name a DNS-rebinding page could point here.
 * @param {object} ctx - plugin context, for the advertised origin.
 * @param {object} req - the incoming request.
 * @returns true for a local same-origin request.
 */
function trusted(ctx, req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const name = hostName(host)
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(name) || name.includes(':')) return true
  try {
    return host === new URL(ctx.webServer.getOrigin()).host
  } catch {
    return false
  }
}

/**
 * Hold one Server-Sent Events response open and register it for broadcast.
 * @param {object} ctx - plugin context, for the advertised origin.
 * @param {object} req - the incoming request; `?notify=granted` marks a page that can raise notifications.
 * @param {object} res - the response owned until the page disconnects.
 * @param {Map<object, boolean>} clients - open event-stream responses and their capability.
 */
function openEventStream(ctx, req, res, clients) {
  if (!trusted(ctx, req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('cross-origin request rejected')
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  let canNotify = false
  try {
    canNotify = new URL(req.url ?? '/', 'http://localhost').searchParams.get('notify') === 'granted'
  } catch {
    // An unparsable query only costs the capability claim.
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  res.write(': dsh-system-notify\n\n')
  clients.set(res, canNotify)
  const drop = () => { clients.delete(res) }
  req.on('close', drop)
  res.on('close', drop)
  res.on('error', drop)
}

/**
 * Answer one JSON response without caching.
 * @param {object} res - the response to complete.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Whether one Session belongs to a child run rather than the user's own work.
 * A user fork also carries `parentSession`, so only `origin` marks a subagent.
 * @param {object} session - the Session that emitted the event.
 * @returns true for subagent Sessions.
 */
function isSubagent(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * Compose the notification title for one Session: its title, then its folder.
 * @param {object} ctx - plugin context.
 * @param {object} session - the Session being reported.
 * @returns a short human label.
 */
function sessionLabel(ctx, session) {
  try {
    const title = ctx.get('sessionTitle')?.get(session)?.title
    if (typeof title === 'string' && title.trim() !== '') return title
  } catch {
    // Title folding is optional; the folder below is always available.
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return basename(cwd)
  return APP_TITLE
}

/**
 * Recover the text of the answer that just closed the turn.
 * @param {object} session - the Session that emitted `turn/end`.
 * @param {number} endSeq - the `turn/end` sequence number.
 * @returns the closing answer text, or `undefined`.
 */
function closingAnswer(session, endSeq) {
  try {
    for (let seq = endSeq - 1; seq > 0 && seq > endSeq - TAIL_SCAN; seq -= 1) {
      const previous = session.eventAt(seq)
      if (previous === undefined) continue
      if (previous.type === 'assistant/message') {
        const content = previous.data?.message?.content
        if (!Array.isArray(content)) return undefined
        const text = content
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join(' ')
        const answer = compact(text, BODY_LIMIT)
        return answer === '' ? undefined : answer
      }
      if (previous.type === 'tool/result' || previous.type === 'user/message') return undefined
    }
  } catch {
    // A projection miss only costs the preview text.
  }
  return undefined
}

/**
 * Notify for one request only when it is still unanswered after the grace
 * period, so auto-answered requests stay silent.
 * @param {object} ctx - plugin context.
 * @param {object} config - effective settings.
 * @param {Map<object, boolean>} clients - open event-stream responses.
 * @param {Set<object>} timers - grace timers owned by this plugin instance.
 * @param {() => object | undefined} describe - builds the notification content.
 * @param {Promise<unknown>} pending - the delegated request answer.
 */
function notifyIfStillPending(ctx, config, clients, timers, describe, pending) {
  let settled = false
  void Promise.resolve(pending).then(() => { settled = true }, () => { settled = true })
  const timer = setTimeout(() => {
    timers.delete(timer)
    if (settled) return
    const message = describe()
    if (message === undefined) return
    void deliver(ctx, config, clients, message)
  }, config.requestGraceMs)
  timers.add(timer)
  // Node keeps the process alive for a pending timer; this one is short and
  // must not delay Host shutdown.
  timer.unref?.()
}

/**
 * Register the notification listeners on the plugin context.
 * @param {object} ctx - plugin context.
 * @param {unknown} rawConfig - the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /** Open event-stream responses and whether each page can raise notifications. */
  const clients = new Map()
  /** Grace timers of unanswered requests, cleared when the plugin unloads. */
  const timers = new Set()

  // The stream lets the page post notifications as the application, which is
  // what gives them the DeepSeek Harness icon. Profiles without a Web server
  // keep the platform-notifier fallback.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: EVENT_STREAM_PATH,
      handler: (req, res) => { openEventStream(ctx, req, res, clients) },
    }))
    // Diagnostic: which delivery path a notification would take right now.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (!trusted(ctx, req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return }
        sendJson(res, 200, {
          clients: clients.size,
          notifying: [...clients.values()].filter(Boolean).length,
          stream: EVENT_STREAM_PATH,
        })
      },
    }))
    // Manual check: `POST /dsh-system-notify/test` raises one sample notification
    // through exactly the path a real event takes.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: TEST_PATH,
      handler: (req, res) => {
        if (!trusted(ctx, req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        void deliver(ctx, config, clients, {
          title: '系统通知测试',
          subtitle: '通道正常',
          body: '任务完成与等待回答时会像这样提醒你。',
        }).then(() => {
          sendJson(res, 200, { clients: clients.size })
        }, () => {
          sendJson(res, 500, { error: 'notification failed' })
        })
      },
    }))
  })

  const heartbeat = setInterval(() => {
    for (const res of [...clients.keys()]) {
      if (res.writableEnded === true || res.destroyed === true) { clients.delete(res); continue }
      try { res.write(': ping\n\n') } catch { clients.delete(res) }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  ctx.effect(() => () => {
    clearInterval(heartbeat)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const res of clients.keys()) {
      try { res.end() } catch { /* the page is already gone */ }
    }
    clients.clear()
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const kind = event.data?.reason?.kind
    let subtitle
    let fallback
    if (kind === 'completed') {
      if (!config.turnComplete) return
      subtitle = '任务完成'
      fallback = '这一轮已结束，可以查看结果。'
    } else if (kind === 'max-tokens') {
      if (!config.turnMaxTokens) return
      subtitle = '输出达到上限'
      fallback = '这一轮因输出上限结束，可以让它接着完成剩下的部分。'
    } else if (kind === 'error') {
      if (!config.turnError) return
      subtitle = '任务出错'
      fallback = '这一轮因错误结束，请打开会话查看。'
    } else {
      // `aborted`, `interrupted`, `forked`, and `blocked` are the user's own
      // doing or a mid-flight hand-off.
      return
    }
    if (!config.subagents && isSubagent(session)) return
    const label = sessionLabel(ctx, session)
    const answer = closingAnswer(session, event.seq)
    void deliver(ctx, config, clients, {
      title: label,
      subtitle,
      body: answer ?? fallback,
      sessionId: session.id,
    })
  })

  ctx.on('user-questions/request', (request, next) => {
    const pending = next()
    if (!config.userQuestion) return pending
    notifyIfStillPending(ctx, config, clients, timers, () => {
      const question = Array.isArray(request?.questions) ? request.questions[0] : undefined
      if (question === undefined) return undefined
      const session = request.agent === undefined ? undefined : ctx.sessions.get(request.agent.id)
      const text = compact([question.header, question.question].filter(part => typeof part === 'string' && part !== '').join('：'), BODY_LIMIT)
      return {
        title: session === undefined ? APP_TITLE : sessionLabel(ctx, session),
        subtitle: '需要你的回答',
        body: text === '' ? 'Agent 正在等待你的回答。' : text,
        sessionId: request.agent?.id,
      }
    }, pending)
    return pending
  })

  ctx.on('approval/request', (request, next) => {
    const pending = next()
    if (!config.approval) return pending
    notifyIfStillPending(ctx, config, clients, timers, () => {
      const session = request?.agent === undefined ? undefined : ctx.sessions.get(request.agent.id)
      const reason = compact(request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason, BODY_LIMIT)
      const tool = typeof request?.toolName === 'string' ? request.toolName : ''
      return {
        title: session === undefined ? APP_TITLE : sessionLabel(ctx, session),
        subtitle: '需要你的授权',
        body: reason !== '' ? `${tool === '' ? '' : `${tool}：`}${reason}` : `工具 ${tool || '调用'} 正在等待你的批准。`,
        sessionId: request?.agent?.id,
      }
    }, pending)
    return pending
  })
}
