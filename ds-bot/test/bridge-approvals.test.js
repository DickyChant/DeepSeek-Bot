import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeApprovals } from '../src/host/bridge-approvals.js'

function fixture() {
  const waiting = []
  const queued = []
  const sent = []
  const abort = new AbortController()
  const push = value => waiting.length ? waiting.shift()({ value, done: false }) : queued.push(value)
  let disposed = false
  const peer = { signal: abort.signal, dispose: async () => { disposed = true; abort.abort(); for (const resolve of waiting.splice(0)) resolve({ done: true }) } }
  push({ type: 'ready', clientId: 'fixture-client' })
  const gateway = { wireStream: { open: async () => ({ [Symbol.asyncIterator]() { return { next: () => queued.length ? Promise.resolve({ value: queued.shift(), done: false }) : new Promise(resolve => waiting.push(resolve)) } } }) } }
  const rt = { chatOwners: new Map([['own-session', 'bot']]), ctx: {
    get: () => gateway,
    connection: {
      createPeer: () => peer,
      createSharedFetchHandler: () => ({ fetch: async (request, receivedPeer) => {
        assert.equal(receivedPeer, peer)
        const input = await request.json()
        assert.equal(input.method, '$events/result')
        assert.equal(input.payload.args.clientId, 'fixture-client')
        sent.push(input.payload.args)
        return Response.json({ result: { ok: true } })
      } }),
    },
  } }
  return { bridge: new BridgeApprovals(rt), push, sent, disposed: () => disposed }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('direct approvals share DSH event identities, delegate unrelated requests and withdraw on cancellation', async () => {
  const { bridge, push, sent, disposed } = fixture()
  const unwatch = await bridge.watch('bot')
  push({ type: 'waterfall', event: 'approval/request', eventId: 'other', agentId: 'foreign-session', request: {} })
  await tick()
  assert.deepEqual(sent[0].outcome, { kind: 'next' })
  push({ type: 'waterfall', event: 'approval/request', eventId: 'pending', agentId: 'own-session', request: { toolName: 'bash', reason: 'Permission needed' } })
  await tick()
  assert.equal(bridge.pending.get('pending').botId, 'bot')
  await bridge.result('pending', { kind: 'result', value: 'allowed-once' })
  assert.equal(bridge.pending.size, 0)
  assert.deepEqual(sent[1].outcome, { kind: 'result', value: 'allowed-once' })
  push({ type: 'waterfall', event: 'approval/request', eventId: 'cancelled', agentId: 'own-session', request: {} })
  push({ type: 'cancel', eventId: 'cancelled' })
  await tick()
  assert.equal(bridge.pending.size, 0)
  unwatch(); await tick()
  assert.equal(disposed(), true)
  assert.equal(bridge.clientId, undefined)
})
