#!/usr/bin/env node
// One-time Strava OAuth setup — run via strava-auth.sh
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const CLIENT_ID = process.env.STRAVA_CLIENT_ID
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET
const TOKEN_FILE = '/root/.config/strava-mcp/config.json'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set')
  process.exit(1)
}

const authUrl = [
  'https://www.strava.com/oauth/authorize',
  `?client_id=${CLIENT_ID}`,
  '&redirect_uri=http://localhost/exchange_token',
  '&response_type=code',
  '&scope=read_all,activity:read_all,profile:read_all',
  '&approval_prompt=force'
].join('')

console.log('\n=== Strava MCP Authentication ===\n')
console.log('1. Open this URL in your browser:\n')
console.log(authUrl)
console.log('\n2. Click "Authorize" on the Strava page.')
console.log('3. Your browser will redirect to localhost and show "This site can\'t be reached" — that\'s expected.')
console.log('4. Copy the full URL from your browser\'s address bar and paste it below.\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

rl.question('Paste the redirect URL here: ', async (input) => {
  rl.close()

  let code
  try {
    const url = new URL(input.trim())
    code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (error) {
      console.error(`\nAuthorization denied: ${error}`)
      process.exit(1)
    }
  } catch {
    // Maybe they pasted just the code directly
    code = input.trim()
  }

  if (!code) {
    console.error('\nNo authorization code found. Make sure to paste the full redirect URL.')
    process.exit(1)
  }

  console.log('\nExchanging code for tokens...')

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
    process.exit(0)
  } catch (e) {
    console.error('Error during token exchange:', e.message)
    process.exit(1)
  }
})
