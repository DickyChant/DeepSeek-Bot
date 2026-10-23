import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BotBridge } from '../src/host/bridge.js'
import { directoryIdentity } from '../src/host/directory.js'
import { fakeContext } from './fake-ctx.js'

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'bot-bridge-'))
  const calls = []
  let listener
  const rt = {
    home, ctx: fakeContext(), load: async () => {}, readOnly: () => undefined,
    botOf: id => id === 'b' ? { id } : undefined,
    chatOf: () => 'part-2', partsOf: () => [{ sessionId: 'part-1' }, { sessionId: 'part-2' }],
    ensureCapabilities: async () => {},
    chatPage: async () => ({ sessionId: 'part-2', cursor: { part: 0 }, items: [
      { kind: 'bot', text: 'Hello', seq: 12, private: 'SECRET' },
      { kind: 'view', view: 'SECRET' },
    ] }),
    subscribeFeed: fn => { listener = fn; return () => { listener = undefined } },
  }
  rt.ctx.sessionController = { prompt: async input => { calls.push(input); return {} } }
  const bridge = new BotBridge(rt)
  const target = { botId: 'b', runtimeId: await directoryIdentity(home) }
  try { await run({ bridge, rt, calls, target, emit: (event, data) => listener?.(event, data) }) }
  finally { await rm(home, { recursive: true, force: true }) }
}

test('chat whitelists text, validates target and uses stable identities across rotation', () => fixture(async ({ bridge, rt, target }) => {
  const first = await bridge.chat(target)
  assert.equal(first.items.length, 1)
  assert.equal(JSON.stringify(first).includes('SECRET'), false)
  assert.equal(first.sendState, 'ready')
  rt.botOf = id => ({ id, kickoff: true })
  assert.equal((await bridge.chat(target)).sendState, 'setup_required')
  rt.botOf = id => id === 'b' ? { id } : undefined
  rt.partsOf = () => [{ sessionId: 'part-1' }, { sessionId: 'part-2' }, { sessionId: 'part-3' }]
  assert.deepEqual((await bridge.chat({ ...target, cursor: { part: 1 } })).items, first.items)
  await assert.rejects(bridge.chat({ ...target, runtimeId: 'replacement' }), { code: 'bot/target-changed' })
  await assert.rejects(bridge.chat({ ...target, botId: 'missing' }), { code: 'bot/not-found' })
  await assert.rejects(bridge.chat({ ...target, cursor: { part: -1 } }), { code: 'bot/invalid' })
}))

test('send resolves the current own chat, queues once, and refuses conflicting retries', () => fixture(async ({ bridge, rt, calls, target }) => {
  rt.chatOf = () => 'rotated'
  const input = { ...target, requestId: 'request-id-00000001', text: 'Hello 你好' }
  const results = await Promise.all([bridge.send(input), bridge.send(input)])
  assert.deepEqual(results[0], results[1])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'rotated')
  assert.equal(calls[0].mode, 'queue')
  await assert.rejects(bridge.send({ ...input, text: 'changed' }), { code: 'bot/request-conflict' })
  rt.readOnly = () => 'another host owns this team'
  await assert.rejects(bridge.send(input), { code: 'bot/read-only' })
}))

test('an uncertain send is never retried by the service', () => fixture(async ({ bridge, rt, target }) => {
  let calls = 0
  rt.ctx.sessionController.prompt = async () => { calls++; throw new Error('timeout after possible delivery') }
  const input = { ...target, requestId: 'request-id-00000002', text: 'Hello' }
  await assert.rejects(bridge.send(input))
  await assert.rejects(bridge.send(input))
  assert.equal(calls, 1)
}))

test('stream selection cannot leak another Bot or raw message/tool fields; unsubscribe works', () => fixture(async ({ bridge, target, emit }) => {
  const events = []
  const off = await bridge.subscribe(target, (event, data) => events.push({ event, data }))
  emit('stream', { botId: 'other', text: 'SECRET' })
  emit('message', { botId: 'b', item: { text: 'PRIVATE' } })
  emit('stream', { botId: 'b', attemptId: 'a', sessionId: 'part-2', text: 'Hello', private: 'SECRET' })
  assert.equal(events.length, 2)
  assert.equal(JSON.stringify(events).includes('SECRET'), false)
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false)
  off(); emit('revision', {})
  assert.equal(events.length, 2)
}))
