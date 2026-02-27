const express = require('express')
const { createProxyMiddleware } = require('http-proxy-middleware')
const crypto = require('crypto')
const { spawn } = require('child_process')
const readline = require('readline')

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

// ── Garmin MCP process manager ────────────────────────────────────────────────
let garminProcess = null
let pendingRequests = new Map() // id -> { res, timer }
let messageBuffer = ''
let initialized = false

function startGarmin() {
  console.log('[garmin] Starting Garmin MCP process...')
  garminProcess = spawn('uvx', [
    '--python', '3.12',
    '--from', 'git+https://github.com/Taxuspt/garmin_mcp',
    'garmin-mcp'
  ], {
    env: { ...process.env, HOME: '/root' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  garminProcess.stderr.on('data', (data) => {
    process.stderr.write(`[garmin stderr] ${data}`)
  })

  // Read line-delimited JSON from stdout
  const rl = readline.createInterface({ input: garminProcess.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      console.log('[garmin] <--', JSON.stringify(msg).slice(0, 200))

      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { res, timer } = pendingRequests.get(msg.id)
        pendingRequests.delete(msg.id)
        clearTimeout(timer)
        res.json(msg)
      }
    } catch (e) {
      console.error('[garmin] Failed to parse:', line)
    }
  })

  garminProcess.on('exit', (code) => {
    console.error(`[garmin] Process exited with code ${code}, restarting in 3s...`)
    initialized = false
    garminProcess = null
    setTimeout(startGarmin, 3000)
  })

  // Send initialize
  setTimeout(() => {
    sendToGarmin({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'garmin-mcp-server', version: '1.0' }
      },
      id: 'init'
    }, null, true)
  }, 2000)
}

function sendToGarmin(msg, res, isInternal = false) {
  if (!garminProcess) {
    if (res) res.status(503).json({ error: 'Garmin process not running' })
    return
  }

  const line = JSON.stringify(msg) + '\n'
  console.log('[garmin] -->', JSON.stringify(msg).slice(0, 200))
  garminProcess.stdin.write(line)

  if (isInternal) {
    // For internal init message, just listen for response
    const origHas = pendingRequests.has.bind(pendingRequests)
    pendingRequests.set(msg.id, {
      res: {
        json: (data) => {
          console.log('[garmin] Initialized:', JSON.stringify(data).slice(0, 200))
          initialized = true
          // Send initialized notification
          garminProcess.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          }) + '\n')
        }
      },
      timer: setTimeout(() => {
        console.error('[garmin] Init timeout')
        pendingRequests.delete(msg.id)
      }, 15000)
    })
    return
  }

  if (res) {
    const timer = setTimeout(() => {
      if (pendingRequests.has(msg.id)) {
        pendingRequests.delete(msg.id)
        res.status(504).json({ error: 'Garmin request timed out' })
      }
    }, 30000)
    pendingRequests.set(msg.id, { res, timer })
  }
}

// Start Garmin process
startGarmin()

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
    <!DOCTYPE html><html><head><title>Authorize Garmin MCP</title>
    <style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}
    h2{margin-bottom:8px}p{color:#555;margin-bottom:24px}
    .btn{display:inline-block;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:15px}
    .approve{background:#2563eb;color:white;margin-right:8px}.deny{background:#e5e7eb;color:#333}</style>
    </head><body>
    <h2>Authorize Garmin MCP</h2>
    <p>Claude is requesting access to your Garmin fitness data.</p>
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
app.get('/health', (req, res) => res.json({ status: 'ok', garminReady: initialized }))

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post('/mcp', authenticate, (req, res) => {
  const msg = req.body
  console.log('[mcp] Received:', JSON.stringify(msg).slice(0, 200))

  // Handle initialize directly so Claude.ai gets a valid 200 even if the
  // subprocess is still starting up.
  if (msg.method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'garmin-mcp', version: '1.0.0' }
      }
    })
  }

  if (!initialized) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Garmin MCP not ready yet, try again in a moment' },
      id: msg.id || null
    })
  }

  // Notifications have no id — forward and return 202 immediately
  if (msg.id === undefined || msg.id === null) {
    garminProcess.stdin.write(JSON.stringify(msg) + '\n')
    return res.status(202).end()
  }

  // Regular request — forward and wait for response
  sendToGarmin(msg, res)
})

// Handle MCP GET (for SSE or protocol discovery)
app.get('/mcp', authenticate, (req, res) => {
  res.status(405).json({ error: 'Use POST for MCP requests' })
})

app.listen(8101, () => {
  console.log('[server] Listening on port 8101')
  console.log(`[server] Base URL: ${BASE_URL}`)
})
