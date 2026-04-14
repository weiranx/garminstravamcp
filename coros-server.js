const express = require('express')
const crypto = require('crypto')
const { spawn } = require('child_process')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const BASE_URL = process.env.BASE_URL

if (!CLIENT_ID || !CLIENT_SECRET || !BASE_URL) {
  console.error('ERROR: CLIENT_ID, CLIENT_SECRET, and BASE_URL must be set')
  process.exit(1)
}

const COROS_EMAIL = process.env.COROS_EMAIL
const COROS_PASSWORD = process.env.COROS_PASSWORD
const COROS_REGION = process.env.COROS_REGION || 'eu'

if (!COROS_EMAIL || !COROS_PASSWORD) {
  console.error('ERROR: COROS_EMAIL and COROS_PASSWORD must be set')
  process.exit(1)
}

// ── COROS MCP process manager ─────────────────────────────────────────────────
let corosProcess = null
let pendingRequests = new Map() // id -> { res, timer }
let initialized = false

function startCoros() {
  console.log('[coros] Starting COROS MCP process...')
  corosProcess = spawn('uvx', [
    '--python', '3.12',
    '--from', 'git+https://github.com/cygnusb/coros-mcp',
    'coros-mcp', 'serve'
  ], {
    env: {
      ...process.env,
      HOME: '/root',
      COROS_EMAIL,
      COROS_PASSWORD,
      COROS_REGION
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  corosProcess.stderr.on('data', (data) => {
    process.stderr.write(`[coros stderr] ${data}`)
  })

  const rl = readline.createInterface({ input: corosProcess.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      console.log('[coros] <--', JSON.stringify(msg).slice(0, 200))

      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { res, timer } = pendingRequests.get(msg.id)
        pendingRequests.delete(msg.id)
        clearTimeout(timer)
        res.json(msg)
      }
    } catch (e) {
      console.error('[coros] Failed to parse:', line)
    }
  })

  corosProcess.on('exit', (code) => {
    console.error(`[coros] Process exited with code ${code}, restarting in 3s...`)
    initialized = false
    corosProcess = null
    setTimeout(startCoros, 3000)
  })

  setTimeout(() => {
    sendToCoros({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coros-mcp-server', version: '1.0' }
      },
      id: 'init'
    }, null, true)
  }, 2000)
}

function sendToCoros(msg, res, isInternal = false) {
  if (!corosProcess) {
    if (res) res.status(503).json({ error: 'COROS process not running' })
    return
  }

  const line = JSON.stringify(msg) + '\n'
  console.log('[coros] -->', JSON.stringify(msg).slice(0, 200))
  corosProcess.stdin.write(line)

  if (isInternal) {
    pendingRequests.set(msg.id, {
      res: {
        json: (data) => {
          console.log('[coros] Initialized:', JSON.stringify(data).slice(0, 200))
          initialized = true
          corosProcess.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          }) + '\n')
        }
      },
      timer: setTimeout(() => {
        console.error('[coros] Init timeout')
        pendingRequests.delete(msg.id)
      }, 15000)
    })
    return
  }

  if (res) {
    const timer = setTimeout(() => {
      if (pendingRequests.has(msg.id)) {
        pendingRequests.delete(msg.id)
        res.status(504).json({ error: 'COROS request timed out' })
      }
    }, 30000)
    pendingRequests.set(msg.id, { res, timer })
  }
}

// Start COROS process
startCoros()

// ── OAuth token store (persisted to disk) ─────────────────────────────────────
const OAUTH_TOKENS_FILE = '/root/.config/coros-mcp/oauth-tokens.json'

const authCodes = new Map()
const tokens = new Map()

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(OAUTH_TOKENS_FILE, 'utf8'))
    for (const t of data) tokens.set(t, Infinity)
    console.log(`[server] Loaded ${data.length} persisted token(s)`)
  } catch { /* file missing or unreadable — start fresh */ }
}

function saveTokens() {
  try {
    const dir = path.dirname(OAUTH_TOKENS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(OAUTH_TOKENS_FILE, JSON.stringify([...tokens.keys()]))
  } catch (e) {
    console.error('[server] Failed to persist tokens:', e.message)
  }
}

loadTokens()

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

const verifyPKCE = (verifier, challenge) => {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return base64url(hash) === challenge
}

// ── OAuth Discovery ───────────────────────────────────────────────────────────
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    code_challenge_methods_supported: ['S256']
  })
})

// ── Authorize GET ─────────────────────────────────────────────────────────────
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query
  if (response_type !== 'code') return res.status(400).send('Unsupported response_type')
  if (client_id !== CLIENT_ID) return res.status(401).send('Invalid client_id')

  res.send(`
    <!DOCTYPE html><html><head><title>Authorize COROS MCP</title>
    <style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}
    h2{margin-bottom:8px}p{color:#555;margin-bottom:24px}
    .btn{display:inline-block;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:15px}
    .approve{background:#0066CC;color:white;margin-right:8px}.deny{background:#e5e7eb;color:#333}</style>
    </head><body>
    <h2>Authorize COROS MCP</h2>
    <p>Claude is requesting access to your COROS fitness data.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${client_id}"/>
      <input type="hidden" name="redirect_uri" value="${redirect_uri}"/>
      <input type="hidden" name="code_challenge" value="${code_challenge || ''}"/>
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}"/>
      <input type="hidden" name="state" value="${state || ''}"/>
      <button type="submit" name="action" value="approve" class="btn approve">Approve</button>
      <button type="submit" name="action" value="deny" class="btn deny">Deny</button>
    </form></body></html>
  `)
})

// ── Authorize POST ────────────────────────────────────────────────────────────
app.post('/authorize', (req, res) => {
  const { action, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.body
  if (action !== 'approve') {
    const url = new URL(redirect_uri)
    url.searchParams.set('error', 'access_denied')
    if (state) url.searchParams.set('state', state)
    return res.redirect(url.toString())
  }
  if (client_id !== CLIENT_ID) return res.status(401).send('Invalid client_id')

  const code = base64url(crypto.randomBytes(32))
  authCodes.set(code, { redirectUri: redirect_uri, codeChallenge: code_challenge, expiresAt: Date.now() + 600000 })

  const url = new URL(redirect_uri)
  url.searchParams.set('code', code)
  if (state) url.searchParams.set('state', state)
  res.redirect(url.toString())
})

// ── Token endpoint ────────────────────────────────────────────────────────────
app.post('/oauth/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body

  if (grant_type === 'client_credentials') {
    if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET)
      return res.status(401).json({ error: 'invalid_client' })
    const token = base64url(crypto.randomBytes(32))
    tokens.set(token, Infinity)
    saveTokens()
    return res.json({ access_token: token, token_type: 'bearer' })
  }

  if (grant_type === 'authorization_code') {
    if (client_id !== CLIENT_ID) return res.status(401).json({ error: 'invalid_client' })
    const stored = authCodes.get(code)
    if (!stored || Date.now() > stored.expiresAt) return res.status(400).json({ error: 'invalid_grant' })
    if (stored.redirectUri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant' })
    if (stored.codeChallenge && code_verifier && !verifyPKCE(code_verifier, stored.codeChallenge))
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE failed' })
    authCodes.delete(code)
    const token = base64url(crypto.randomBytes(32))
    tokens.set(token, Infinity)
    saveTokens()
    return res.json({ access_token: token, token_type: 'bearer' })
  }

  res.status(400).json({ error: 'unsupported_grant_type' })
})

// ── Auth middleware ───────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' })
  const token = auth.slice(7)
  const exp = tokens.get(token)
  if (!exp || Date.now() > exp) { tokens.delete(token); return res.status(401).json({ error: 'invalid_token' }) }
  next()
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', corosReady: initialized }))

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post('/mcp', authenticate, (req, res) => {
  const msg = req.body
  console.log('[mcp] Received:', JSON.stringify(msg).slice(0, 200))

  if (msg.method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'coros-mcp', version: '1.0.0' }
      }
    })
  }

  if (!initialized) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'COROS MCP not ready yet, try again in a moment' },
      id: msg.id || null
    })
  }

  if (msg.id === undefined || msg.id === null) {
    corosProcess.stdin.write(JSON.stringify(msg) + '\n')
    return res.status(202).end()
  }

  sendToCoros(msg, res)
})

app.get('/mcp', authenticate, (req, res) => {
  res.status(405).json({ error: 'Use POST for MCP requests' })
})

app.listen(8103, () => {
  console.log('[server] Listening on port 8103')
  console.log(`[server] Base URL: ${BASE_URL}`)
})
