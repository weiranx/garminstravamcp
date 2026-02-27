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
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET || !BASE_URL) {
  console.error('ERROR: CLIENT_ID, CLIENT_SECRET, and BASE_URL must be set')
  process.exit(1)
}

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error('ERROR: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set')
  process.exit(1)
}

// ── Strava token management ───────────────────────────────────────────────────
const TOKEN_FILE = '/root/.config/strava-mcp/config.json'

function loadStravaTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    }
  } catch (e) {
    console.error('[strava] Failed to read token file:', e.message)
  }
  return {
    access_token: process.env.STRAVA_ACCESS_TOKEN || '',
    refresh_token: process.env.STRAVA_REFRESH_TOKEN || '',
    expires_at: 0
  }
}

async function refreshStravaToken(tokens) {
  if (!tokens.refresh_token) {
    console.error('[strava] No refresh token available. Run strava-auth.sh first.')
    return tokens
  }
  const expiresAt = tokens.expires_at || 0
  if (Date.now() / 1000 < expiresAt - 300) return tokens // still valid

  console.log('[strava] Refreshing access token...')
  try {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      })
    })
    const fresh = await res.json()
    if (fresh.access_token) {
      const updated = { ...tokens, ...fresh }
      const dir = path.dirname(TOKEN_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(updated, null, 2))
      console.log('[strava] Token refreshed successfully')
      return updated
    }
    console.error('[strava] Token refresh failed:', JSON.stringify(fresh))
    return tokens
  } catch (e) {
    console.error('[strava] Token refresh error:', e.message)
    return tokens
  }
}

// ── Strava MCP process manager ────────────────────────────────────────────────
let stravaProcess = null
let pendingRequests = new Map() // id -> { res, timer }
let initialized = false

async function startStrava() {
  console.log('[strava] Starting Strava MCP process...')

  let tokens = loadStravaTokens()
  tokens = await refreshStravaToken(tokens)

  stravaProcess = spawn('npx', ['-y', '@r-huijts/strava-mcp-server'], {
    env: {
      ...process.env,
      HOME: '/root',
      STRAVA_CLIENT_ID,
      STRAVA_CLIENT_SECRET,
      STRAVA_ACCESS_TOKEN: tokens.access_token || '',
      STRAVA_REFRESH_TOKEN: tokens.refresh_token || ''
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  stravaProcess.stderr.on('data', (data) => {
    process.stderr.write(`[strava stderr] ${data}`)
  })

  const rl = readline.createInterface({ input: stravaProcess.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      console.log('[strava] <--', JSON.stringify(msg).slice(0, 200))

      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { res, timer } = pendingRequests.get(msg.id)
        pendingRequests.delete(msg.id)
        clearTimeout(timer)
        res.json(msg)
      }
    } catch (e) {
      console.error('[strava] Failed to parse:', line)
    }
  })

  stravaProcess.on('exit', (code) => {
    console.error(`[strava] Process exited with code ${code}, restarting in 3s...`)
    initialized = false
    stravaProcess = null
    setTimeout(startStrava, 3000)
  })

  setTimeout(() => {
    sendToStrava({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'strava-mcp-server', version: '1.0' }
      },
      id: 'init'
    }, null, true)
  }, 2000)
}

function sendToStrava(msg, res, isInternal = false) {
  if (!stravaProcess) {
    if (res) res.status(503).json({ error: 'Strava process not running' })
    return
  }

  const line = JSON.stringify(msg) + '\n'
  console.log('[strava] -->', JSON.stringify(msg).slice(0, 200))
  stravaProcess.stdin.write(line)

  if (isInternal) {
    pendingRequests.set(msg.id, {
      res: {
        json: (data) => {
          console.log('[strava] Initialized:', JSON.stringify(data).slice(0, 200))
          initialized = true
          stravaProcess.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          }) + '\n')
        }
      },
      timer: setTimeout(() => {
        console.error('[strava] Init timeout')
        pendingRequests.delete(msg.id)
      }, 15000)
    })
    return
  }

  if (res) {
    const timer = setTimeout(() => {
      if (pendingRequests.has(msg.id)) {
        pendingRequests.delete(msg.id)
        res.status(504).json({ error: 'Strava request timed out' })
      }
    }, 30000)
    pendingRequests.set(msg.id, { res, timer })
  }
}

// Start Strava process
startStrava()

// Refresh tokens every 5.5 hours (Strava tokens expire after 6 hours)
setInterval(async () => {
  const tokens = loadStravaTokens()
  await refreshStravaToken(tokens)
}, 5.5 * 60 * 60 * 1000)

// ── In-memory OAuth stores ────────────────────────────────────────────────────
const authCodes = new Map()
const tokens = new Map()

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
    <!DOCTYPE html><html><head><title>Authorize Strava MCP</title>
    <style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}
    h2{margin-bottom:8px}p{color:#555;margin-bottom:24px}
    .btn{display:inline-block;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:15px}
    .approve{background:#FC4C02;color:white;margin-right:8px}.deny{background:#e5e7eb;color:#333}</style>
    </head><body>
    <h2>Authorize Strava MCP</h2>
    <p>Claude is requesting access to your Strava fitness data.</p>
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
    tokens.set(token, Date.now() + 3600000)
    return res.json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
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
    tokens.set(token, Date.now() + 3600000)
    for (const [t, exp] of tokens.entries()) if (Date.now() > exp) tokens.delete(t)
    return res.json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
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
app.get('/health', (req, res) => res.json({ status: 'ok', stravaReady: initialized }))

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post('/mcp', authenticate, (req, res) => {
  const msg = req.body
  console.log('[mcp] Received:', JSON.stringify(msg).slice(0, 200))

  // Handle initialize directly so Claude.ai gets a valid 200 even if the
  // subprocess is still starting up. Without this, 503 causes Claude.ai to
  // show "McpEndpointNotFound" and permanently revert the connection.
  if (msg.method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'strava-mcp', version: '1.0.0' }
      }
    })
  }

  if (!initialized) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Strava MCP not ready yet, try again in a moment' },
      id: msg.id || null
    })
  }

  if (msg.id === undefined || msg.id === null) {
    stravaProcess.stdin.write(JSON.stringify(msg) + '\n')
    return res.status(202).end()
  }

  sendToStrava(msg, res)
})

app.get('/mcp', authenticate, (req, res) => {
  res.status(405).json({ error: 'Use POST for MCP requests' })
})

app.listen(8102, () => {
  console.log('[server] Listening on port 8102')
  console.log(`[server] Base URL: ${BASE_URL}`)
})
