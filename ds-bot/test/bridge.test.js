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
  rt.ctx.get = name => rt.ctx[name]
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
  emit('stream', { botId: 'b', sessionId: 'group-session', text: 'SECRET' })
  emit('message', { botId: 'b', item: { text: 'PRIVATE' } })
  emit('stream', { botId: 'b', attemptId: 'a', sessionId: 'part-2', text: 'Hello', private: 'SECRET' })
  assert.equal(events.length, 2)
  assert.equal(JSON.stringify(events).includes('SECRET'), false)
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false)
  off(); emit('revision', {})
  assert.equal(events.length, 2)
}))

test('native model controls whitelist the catalog and apply a model only on explicit request', () => fixture(async ({ bridge, rt, target }) => {
  let changed = 0
  rt.catalog = async () => [{ ref: 'mock/one', name: 'One', providerName: 'Mock', secret: 'SECRET' }, { ref: 'mock/locked', name: 'Locked', providerName: 'Mock', needsKey: true }]
  rt.workView = () => ({ b: {} })
  rt.updateBot = async (id, patch) => { assert.equal(id, 'b'); assert.deepEqual(patch, { model: 'mock/one' }); changed++ }
  const settings = await bridge.settings(target)
  assert.equal(changed, 0)
  assert.equal(settings.working, true)
  assert.equal(JSON.stringify(settings).includes('SECRET'), false)
  assert.equal(settings.models[1].available, false)
  const input = { ...target, requestId: 'control-id-000001', action: 'model', model: 'mock/one' }
  await Promise.all([bridge.control(input), bridge.control(input)])
  assert.equal(changed, 1)
  await assert.rejects(bridge.control({ ...input, model: 'mock/locked' }), { code: 'bot/request-conflict' })
  await assert.rejects(bridge.control({ ...input, requestId: 'control-id-000002', model: 'mock/locked' }), { code: 'bot/model-unavailable' })
  rt.readOnly = () => 'read only'
  await assert.rejects(bridge.control(input), { code: 'bot/read-only' })
}))

test('stop targets the displayed own session and cannot follow a rotated chat or run twice', () => fixture(async ({ bridge, rt, target }) => {
  let stops = 0
  rt.resolveAgent = async id => { assert.equal(id, 'part-2'); return { cancel: () => { stops++ } } }
  const input = { ...target, requestId: 'control-id-000003', action: 'stop', sessionId: 'part-2' }
  await Promise.all([bridge.control(input), bridge.control(input)])
  assert.equal(stops, 1)
  rt.chatOf = () => 'part-3'
  await assert.rejects(bridge.control({ ...input, requestId: 'control-id-000004' }), { code: 'bot/target-changed' })
  assert.equal(stops, 1)
}))

test('group send uses the room session and rejects a Bot outside the group', () => fixture(async ({ bridge, rt, calls, target }) => {
  rt.roomOf = id => id === 'room' ? { id, members: ['b'], log: [{ seq: 1, who: 'Writer', botId: 'b', text: 'Group reply' }] } : undefined
  const group = { ...target, roomId: 'room' }
  const page = await bridge.chat(group)
  assert.equal(page.sessionId, 'room')
  assert.equal(page.items[0].name, 'Writer')
  await bridge.send({ ...group, text: '@Writer hello', requestId: 'group-request-0001' })
  assert.equal(calls[0].sessionId, 'room')
  await assert.rejects(bridge.chat({ ...group, roomId: 'foreign' }), { code: 'bot/target-changed' })
  await assert.rejects(bridge.send({ ...target, text: '@Writer hello', requestId: 'group-request-0001' }), { code: 'bot/request-conflict' })
}))

test('uploads bind to the displayed session; receipts cannot follow a rotation', () => fixture(async ({ bridge, rt, calls, target }) => {
  let uploaded = 0
  rt.resolveAgent = async id => ({ id })
  rt.ctx.fileUploads = { upload: async (agent, input) => { uploaded++; assert.equal(agent.id, 'part-2'); return { receiptId: 'receipt', file: { name: input.name, bytes: 5 } } } }
  const input = { ...target, sessionId: 'part-2', name: '测试.txt', data: Buffer.from('hello').toString('base64') }
  assert.equal((await bridge.upload(input)).receiptId, 'receipt')
  await assert.rejects(bridge.upload({ ...input, sessionId: 'part-1' }), { code: 'bot/target-changed' })
  await assert.rejects(bridge.upload({ ...input, data: 'not base64' }), { code: 'bot/invalid' })
  assert.equal(uploaded, 1)
  await bridge.send({ ...target, sessionId: 'part-2', receipts: ['receipt'], text: '', requestId: 'files-request-0001' })
  assert.deepEqual(calls[0].content, [{ type: 'file', receiptId: 'receipt' }])
  rt.chatOf = () => 'rotated'
  await assert.rejects(bridge.send({ ...target, sessionId: 'part-2', receipts: ['receipt'], text: '', requestId: 'files-request-0002' }), { code: 'bot/target-changed' })
}))

test('download capabilities are scoped to their Bot and conversation and expire', () => fixture(async ({ bridge, rt, target }) => {
  const [file] = bridge.filesView(target, [{ attachmentId: 'hash', name: 'hello.txt', bytes: 5 }])
  rt.ctx.attachments = { async* readFileStream() { yield Buffer.from('hello') } }
  assert.equal((await bridge.download({ ...target, fileId: file.id })).data, Buffer.from('hello').toString('base64'))
  rt.roomOf = id => ({ id, members: ['b'] })
  await assert.rejects(bridge.download({ ...target, roomId: 'room', fileId: file.id }), { code: 'bot/target-changed' })
  bridge.files.get(file.id).until = 0
  await assert.rejects(bridge.download({ ...target, fileId: file.id }), { code: 'bot/target-changed' })
}))

test('group approval answers require the exact pending session and an explicit single decision', () => fixture(async ({ bridge, rt, target }) => {
  rt.roomOf = id => ({ id, members: ['b'] })
  let pending = true
  rt.approvalsView = () => pending ? [{ id: 'approval', botId: 'b', roomId: 'room', sessionId: 'hidden', tool: 'bash', reason: 'permission', answerable: true }] : []
  rt.answerApproval = (id, choice) => { assert.equal(id, 'approval'); assert.equal(choice, 'reject'); pending = false }
  const input = { ...target, roomId: 'room', approvalId: 'approval', sessionId: 'hidden', choice: 'reject', requestId: 'approval-request-01' }
  await assert.rejects(bridge.answer({ ...input, sessionId: 'foreign' }), { code: 'bot/stale' })
  await assert.rejects(bridge.answer({ ...input, choice: 'always' }), { code: 'bot/invalid' })
  assert.equal((await bridge.answer(input)).accepted, true)
  await assert.rejects(bridge.answer(input), { code: 'bot/stale' })
}))
