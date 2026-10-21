const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const express = require('express')

const CALLBACK = 'https://client.example/oauth/callback'
const CLIENT = 'test-client'
const VERIFIER = 'v'.repeat(43)
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url')

// Run the actual Express routes and stdio response handler. Only the subprocess,
// token disk and long timers are faked; no credentials or host paths are touched.
async function proxy(t, redirects = CALLBACK) {
  const timers = new Set()
  const sent = []
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      sent.push(JSON.parse(chunk.toString()))
      done()
    }
  })
  let server
  const makeApp = () => {
    const app = express()
    app.listen = (...args) => {
      server = require('node:http').createServer(app).listen(0, '127.0.0.1', args.at(-1))
      return server
    }
    return app
  }
  Object.assign(makeApp, express)
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return makeApp
      if (name === 'child_process') return { spawn: () => child }
      if (name === 'fs') return {
        readFileSync() { throw new Error('no saved tokens') },
        existsSync: () => true,
        writeFileSync() {}
      }
      return require(name)
    },
    process: { env: { CLIENT_ID: CLIENT, CLIENT_SECRET: 'secret', BASE_URL: 'https://gpx.example',
      GPX_OAUTH_REDIRECT_URIS: redirects }, stderr: { write() {} } },
    console: { log() {}, error() {} }, URL,
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  vm.runInContext(fs.readFileSync(process.env.GPX_SERVER_SOURCE || path.join(__dirname, '../gpx-server.js'), 'utf8'), context)
  t.after(async () => {
    child.stdout.end()
    child.stderr.end()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  function request(route, body, token) {
    const response = fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)
    })
    // A failing assertion may close the fixture while another call is in flight.
    // Awaiting the returned promise still propagates its original rejection.
    response.catch(() => {})
    return response
  }
  function reply(msg) { child.stdout.write(JSON.stringify(msg) + '\n') }
  function fireTimer(ms) {
    const timer = [...timers].find(timer => timer.ms === ms)
    assert.ok(timer, `expected ${ms}ms timer`)
    timers.delete(timer)
    timer.fn()
  }
  function ready() {
    fireTimer(2000)
    const init = sent.at(-1)
    reply({ jsonrpc: '2.0', id: init.id, result: {} })
    return init
  }
  async function token() {
    const res = await request('/oauth/token', {
      grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'secret'
    })
    assert.equal(res.status, 200)
    return (await res.json()).access_token
  }
  return { request, ready, token, reply, sent, timers, fireTimer }
}

const authorization = overrides => ({ response_type: 'code', client_id: CLIENT,
  redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: 'S256',
  state: 'client-state', ...overrides })

function query(params) {
  const values = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(item => values.append(`${key}[]`, item))
    else if (value !== undefined) values.append(key, value)
  }
  return values.toString()
}

test('callback allowlist rejects arbitrary, missing, malformed and non-exact URLs on GET, approval and denial', async t => {
  const p = await proxy(t)
  for (const redirect_uri of [undefined, 'not a URL', 'https://attacker.example/cb',
    CALLBACK + '/extra', CALLBACK + '?extra=1', CALLBACK + '#fragment',
    'https://client.example.attacker.example/oauth/callback', [CALLBACK]]) {
    const params = authorization({ redirect_uri })
    const get = await p.request('/authorize?' + query(params))
    assert.equal(get.status, 400)
    assert.equal(get.headers.get('location'), null)
    for (const action of ['approve', 'deny']) {
      const res = await p.request('/authorize', { ...params, action })
      assert.equal(res.status, 400)
      assert.equal(res.headers.get('location'), null)
    }
  }
  const res = await p.request('/authorize', authorization({ action: 'deny', client_id: 'wrong' }))
  assert.equal(res.status, 401)
})

test('empty callback configuration disables authorization-code login', async t => {
  const p = await proxy(t, '')
  assert.equal((await p.request('/authorize?' + new URLSearchParams(authorization()))).status, 400)
  assert.equal((await p.request('/authorize', authorization({ action: 'approve' }))).status, 400)
  assert.ok(await p.token())
})

test('allowlisted consent escapes form values and preserves denial state', async t => {
  const p = await proxy(t, `${CALLBACK},https://other.example/callback`)
  const params = authorization({ state: '\"><script>alert(1)</script>' })
  const page = await p.request('/authorize?' + new URLSearchParams(params))
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'))
  const denied = await p.request('/authorize', { ...params, action: 'deny' })
  assert.equal(denied.status, 302)
  const location = new URL(denied.headers.get('location'))
  assert.equal(location.origin + location.pathname, CALLBACK)
  assert.equal(location.searchParams.get('state'), params.state)
  assert.equal(location.searchParams.get('error'), 'access_denied')
  assert.equal(location.searchParams.has('code'), false)
})

test('PKCE rejects missing, empty, wrong and non-string verifiers; valid S256 works once', async t => {
  const p = await proxy(t)
  const approval = await p.request('/authorize', authorization({ action: 'approve' }))
  assert.equal(approval.status, 302)
  const code = new URL(approval.headers.get('location')).searchParams.get('code')
  const exchange = { grant_type: 'authorization_code', client_id: CLIENT, redirect_uri: CALLBACK, code }
  for (const code_verifier of [undefined, '', 'wrong', 'w'.repeat(43), [VERIFIER], { value: VERIFIER }]) {
    const res = await p.request('/oauth/token', { ...exchange, code_verifier })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_grant')
  }
  assert.equal((await p.request('/oauth/token', { ...exchange, redirect_uri: CALLBACK + '/wrong', code_verifier: VERIFIER })).status, 400)
  const res = await p.request('/oauth/token', { ...exchange, code_verifier: VERIFIER })
  assert.equal(res.status, 200)
  assert.ok((await res.json()).access_token)
  assert.equal((await p.request('/oauth/token', { ...exchange, code_verifier: VERIFIER })).status, 400)
})

test('authorization rejects unsupported PKCE methods and malformed challenges on both routes', async t => {
  const p = await proxy(t)
  for (const overrides of [{ code_challenge_method: 'plain' }, { code_challenge_method: '' },
    { code_challenge: '' }, { code_challenge: 'short' }, { code_challenge: [CHALLENGE] }]) {
    const params = authorization(overrides)
    assert.equal((await p.request('/authorize?' + query(params))).status, 400)
    assert.equal((await p.request('/authorize', { ...params, action: 'approve' })).status, 400)
  }
})

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('request did not reach subprocess')
}

test('concurrent callers with identical IDs receive their own result/error with original ID types', async t => {
  const p = await proxy(t)
  const init = p.ready()
  const tokens = await Promise.all([p.token(), p.token()])
  assert.notEqual(tokens[0], tokens[1])
  assert.equal((await p.request('/mcp', { id: 1, method: 'tools/list' })).status, 401)
  const calls = []
  for (const [index, id] of [1, 1, '1', 0, 'init'].entries()) {
    calls.push(p.request('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { marker: index } }, tokens[index % 2]))
  }
  await until(() => p.sent.filter(msg => msg.method === 'tools/call').length === calls.length)
  const forwarded = p.sent.filter(msg => msg.method === 'tools/call')
  assert.equal(new Set([init.id, ...forwarded.map(msg => msg.id)]).size, 6)
  for (const msg of forwarded.toReversed()) {
    const marker = msg.params.marker
    p.reply({ jsonrpc: '2.0', id: msg.id, ...(marker === 1
      ? { error: { code: -32000, message: 'caller one error' } } : { result: { marker } }) })
  }
  const responses = await Promise.all(calls)
  for (const [index, res] of responses.entries()) {
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.id, [1, 1, '1', 0, 'init'][index])
    if (index === 1) assert.equal(data.error.message, 'caller one error')
    else assert.equal(data.result.marker, index)
  }
  assert.equal([...p.timers].filter(timer => timer.ms === 180000).length, 0)
})

test('timed-out response cannot capture a later caller reusing the same ID; notifications have no proxy ID', async t => {
  const p = await proxy(t)
  p.ready()
  const token = await p.token()
  const first = p.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)
  await until(() => p.sent.some(msg => msg.method === 'tools/list'))
  const oldId = p.sent.at(-1).id
  p.fireTimer(180000)
  assert.equal((await first).status, 504)
  const second = p.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)
  await until(() => p.sent.filter(msg => msg.method === 'tools/list').length === 2)
  const newId = p.sent.at(-1).id
  assert.notEqual(oldId, newId)
  p.reply({ jsonrpc: '2.0', id: oldId, result: { stale: true } })
  p.reply({ jsonrpc: '2.0', id: newId, result: { fresh: true } })
  assert.deepEqual(await (await second).json(), { jsonrpc: '2.0', id: 1, result: { fresh: true } })
  assert.equal((await p.request('/mcp', { jsonrpc: '2.0', method: 'notifications/test' }, token)).status, 202)
  assert.equal(p.sent.at(-1).id, undefined)
})
