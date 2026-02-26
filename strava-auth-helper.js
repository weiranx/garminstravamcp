#!/usr/bin/env node
// One-time Strava OAuth setup — run via strava-auth.sh
const http = require('http')
const fs = require('fs')
const path = require('path')

const CLIENT_ID = process.env.STRAVA_CLIENT_ID
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET
const TOKEN_FILE = '/root/.config/strava-mcp/config.json'
const CALLBACK_PORT = 8080

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set')
  process.exit(1)
}

const authUrl = [
  'https://www.strava.com/oauth/authorize',
  `?client_id=${CLIENT_ID}`,
  `&redirect_uri=http://localhost:${CALLBACK_PORT}/callback`,
  '&response_type=code',
  '&scope=read_all,activity:read_all,profile:read_all',
  '&approval_prompt=force'
].join('')

console.log('\n=== Strava MCP Authentication ===\n')
console.log('Open this URL in your browser:\n')
console.log(authUrl)
console.log('\nAfter authorizing, Strava will redirect to localhost.')
console.log('Waiting for callback...\n')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)

  if (url.pathname !== '/callback') {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body><h2>Authorization denied: ${error}</h2><p>You can close this window.</p></body></html>`)
    server.close()
    process.exit(1)
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end('<html><body><h2>No authorization code received</h2></body></html>')
    return
  }

  console.log('Received authorization code, exchanging for tokens...')

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code'
      })
    })
    const tokenData = await tokenRes.json()

    if (!tokenData.access_token) {
      console.error('Token exchange failed:', JSON.stringify(tokenData, null, 2))
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end(`<html><body><h2>Token exchange failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`)
      server.close()
      process.exit(1)
    }

    const dir = path.dirname(TOKEN_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const config = {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      athlete: tokenData.athlete
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(config, null, 2))

    console.log('\nTokens saved successfully!')
    console.log('\nAdd these to your .env file:')
    console.log(`STRAVA_ACCESS_TOKEN=${tokenData.access_token}`)
    console.log(`STRAVA_REFRESH_TOKEN=${tokenData.refresh_token}`)
    console.log('\nThen start the service: docker compose up -d strava-mcp\n')

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window and return to your terminal.</p></body></html>')

    setTimeout(() => { server.close(); process.exit(0) }, 1000)
  } catch (e) {
    console.error('Error during token exchange:', e.message)
    res.writeHead(500)
    res.end('Error: ' + e.message)
    server.close()
    process.exit(1)
  }
})

server.listen(CALLBACK_PORT, () => {
  console.log(`Callback server listening on port ${CALLBACK_PORT}`)
})
