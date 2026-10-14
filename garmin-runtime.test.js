const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createGarminRuntime } = require('./garmin-runtime')

function fixture() {
  let clock = 1000
  const children = [], timers = new Set(), logs = []
  const runtime = createGarminRuntime({
    now: () => clock, log: { log: x => logs.push(x), error: x => logs.push(x) },
    schedule: (fn, delay) => { const t = { fn, delay }; timers.add(t); return t },
    cancel: t => timers.delete(t),
    spawn: (command, args) => {
      assert.equal(command, '/opt/garmin-runtime/bin/python')
      assert.deepEqual(args, ['-m', 'garmin_mcp'])
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.kill = () => { child.emit('close', 1) }
      children.push(child); return child
    }
  })
  const ready = child => child.stdout.write(JSON.stringify({ id: 'pulse-runtime-init', result: {} }) + '\n')
  return { runtime, children, timers, logs, ready, advance: ms => { clock += ms } }
}

test('short-lived successful initializations do not reset crash backoff', () => {
  const f = fixture(); f.runtime.start(); f.ready(f.children[0])
  assert.equal(f.runtime.isReady(), true)
  f.children[0].emit('close', 1)
  const retry = [...f.timers][0]; assert.equal(retry.delay, 30000)
  f.timers.delete(retry); retry.fn(); f.ready(f.children[1]); f.children[1].emit('close', 1)
  assert.equal([...f.timers][0].delay, 60000)
})

test('authentication failures across stderr chunks wait at least 15 minutes and logs omit payloads', () => {
  const f = fixture(); f.runtime.start()
  f.children[0].stderr.write('HTTPError: 429 Too Many ')
  f.children[0].stderr.write('Requests secret-token')
  for (let i = 0; i < 100; i++) f.children[0].stderr.write(' secret-token HTTPError: 429 Too Many Requests')
  f.children[0].emit('close', 1)
  assert.equal([...f.timers][0].delay, 900000)
  assert.equal(f.logs.filter(x => x.includes('Authentication')).length, 1)
  assert.equal(f.logs.some(x => x.includes('secret-token')), false)
})

test('process exit fails in-flight requests and clears their timeout', () => {
  const f = fixture(); f.runtime.start(); f.ready(f.children[0])
  let status, body
  const res = { status: s => { status = s; return res }, json: x => { body = x } }
  f.runtime.send({ id: 42, method: 'tools/list' }, res)
  f.children[0].emit('close', 1)
  assert.equal(status, 503); assert.equal(body.error, 'Garmin process restarting')
  assert.equal(f.timers.size, 1)
})

test('protocol errors never report readiness and graceful stop never restarts', () => {
  const f = fixture(); f.runtime.start()
  f.children[0].stdout.write(JSON.stringify({ id: 'pulse-runtime-init', error: {} }) + '\n')
  assert.equal(f.runtime.isReady(), false)
  f.runtime.stop(); assert.equal(f.timers.size, 0)
})

test('only five minutes of stable readiness resets the crash backoff', () => {
  const f = fixture(); f.runtime.start(); f.children[0].emit('close', 1)
  const retry = [...f.timers][0]; f.timers.delete(retry); retry.fn()
  f.ready(f.children[1]); f.advance(300001); f.children[1].emit('close', 1)
  assert.equal([...f.timers][0].delay, 30000)
})
