const { spawn } = require('node:child_process')
const readline = require('node:readline')

function createGarminRuntime(options = {}) {
  const launch = options.spawn || spawn
  const schedule = options.schedule || setTimeout
  const cancel = options.cancel || clearTimeout
  const now = options.now || Date.now
  const log = options.log || console
  let child = null, ready = false, stopping = false, restartTimer = null
  let retryMs = 30000
  const pending = new Map()

  function failPending() {
    for (const { res, timer } of pending.values()) {
      cancel(timer)
      res.status(503).json({ error: 'Garmin process restarting' })
    }
    pending.clear()
  }

  function start() {
    if (stopping || child) return
    log.log('[garmin] Starting pinned runtime')
    const process = launch('/opt/garmin-runtime/bin/python', ['-m', 'garmin_mcp'], {
      env: { ...global.process.env, HOME: '/root', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child = process
    let finished = false, authFailure = false, readyAt = null
    let nextDiagnostic = 0, nextAuthDiagnostic = 0
    let diagnosticTail = ''
    const initId = 'pulse-runtime-init'
    const initTimer = schedule(() => {
      if (child === process && !ready) {
        log.error('[garmin] Initialization timed out')
        process.kill('SIGTERM')
      }
    }, 20000)

    function finish() {
      if (finished) return
      finished = true
      cancel(initTimer)
      if (child !== process) return
      child = null
      ready = false
      failPending()
      if (stopping) return
      // Successful protocol initialization alone must not reset a crash loop.
      if (readyAt !== null && now() - readyAt >= 300000) retryMs = 30000
      const delay = authFailure ? Math.max(retryMs, 900000) : retryMs
      retryMs = Math.min(delay * 2, 900000)
      log.error(`[garmin] Runtime stopped; retry in ${delay / 1000}s`)
      restartTimer = schedule(start, delay)
    }

    process.on('error', finish)
    process.on('close', finish)
    process.stdin.on('error', () => process.kill('SIGTERM'))
    process.stderr.on('data', chunk => {
      // Bound logging and retain no response bodies, URLs, tokens or account data.
      const text = diagnosticTail + String(chunk)
      diagnosticTail = text.slice(-256)
      if (/GarminConnectTooManyRequestsError|HTTPError.*\b(403|429)\b|\b(403|429)\b.*(Forbidden|Too Many Requests)|failed.*(oauth|login)|oauth.*(failed|error)/i.test(text)) {
        authFailure = true
        if (now() >= nextAuthDiagnostic) {
          log.error('[garmin] Authentication or rate-limit failure; restart backoff is at least 15 minutes')
          nextAuthDiagnostic = now() + 60000
        }
      } else if (now() >= nextDiagnostic) {
        log.error('[garmin] Runtime diagnostic output received; repeated details suppressed')
        nextDiagnostic = now() + 60000
      }
    })
    const lines = readline.createInterface({ input: process.stdout })
    lines.on('line', line => {
      if (stopping || child !== process || finished || !line.trim()) return
      let msg
      try { msg = JSON.parse(line) } catch {
        if (now() >= nextDiagnostic) {
          log.error('[garmin] Ignored invalid protocol output')
          nextDiagnostic = now() + 60000
        }
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.id === initId) {
        if (msg.error || !msg.result) {
          log.error('[garmin] Initialization failed')
          process.kill('SIGTERM')
          return
        }
        cancel(initTimer)
        ready = true
        readyAt = now()
        process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
        log.log('[garmin] Runtime ready')
      } else if (pending.has(msg.id)) {
        const { res, timer } = pending.get(msg.id)
        pending.delete(msg.id)
        cancel(timer)
        res.json(msg)
      }
    })
    process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: initId,
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'garmin-mcp-server', version: '1.0' } } }) + '\n')
  }

  function send(msg, res) {
    if (!child || !ready) {
      if (res) res.status(503).json({ error: 'Garmin process not ready' })
      return false
    }
    if (res && pending.has(msg.id)) {
      res.status(409).json({ error: 'Request ID is already in use' })
      return false
    }
    if (res) {
      const timer = schedule(() => {
        pending.delete(msg.id)
        res.status(504).json({ error: 'Garmin request timed out' })
      }, 30000)
      pending.set(msg.id, { res, timer })
    }
    child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }

  function stop() {
    stopping = true
    cancel(restartTimer)
    ready = false
    failPending()
    child?.kill('SIGTERM')
  }
  return { start, send, stop, isReady: () => ready }
}

module.exports = { createGarminRuntime }
