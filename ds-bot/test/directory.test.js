import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { directoryIdentity, directorySnapshot, install } from '../src/host/directory.js'
import { fakeContext } from './fake-ctx.js'

function runtime() {
  return {
    state: { bots: { b: { id: 'b', name: 'Writer', role: 'Writes', instructions: 'PRIVATE' } }, rooms: { g: { id: 'g', name: 'Team', members: ['b'], sessions: { b: 'group-2' }, log: ['PRIVATE'] } }, questions: {}, views: {} },
    chatOf: () => 'direct-2',
    partsOf: (_bot, room) => (room ? ['group-1', 'group-2'] : ['direct-1', 'direct-2']).map(sessionId => ({ sessionId })),
    activityView: () => ({}), workView: () => ({}), roomWorkView: () => ({}), approvalsView: () => [], readOnly: () => undefined,
  }
}

test('one Bot survives part rotation and group activity; the directory is a whitelist', () => {
  const rt = runtime()
  rt.roomWorkView = () => ({ g: [{ botId: 'b', said: 'PRIVATE' }] })
  const result = directorySnapshot(rt, 'runtime', 123)
  assert.equal(result.bots.length, 1)
  assert.equal(result.bots[0].status, 'working')
  assert.equal(result.bots[0].conversations.length, 2)
  assert.deepEqual(result.bots[0].conversations[0].sessionIds, ['direct-1', 'direct-2'])
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  rt.chatOf = () => 'direct-3'
  const next = directorySnapshot(rt, 'runtime')
  assert.equal(next.bots[0].id, result.bots[0].id)
  assert.equal(next.bots[0].conversations[0].id, result.bots[0].conversations[0].id)
  assert.equal(next.bots[0].conversations[0].currentSessionId, 'direct-3')
})

test('approval or question wins over work; another host cannot report this host as idle', () => {
  const rt = runtime()
  rt.workView = () => ({ b: { since: 1 } })
  rt.approvalsView = () => [{ botId: 'b', reason: 'PRIVATE' }]
  assert.equal(directorySnapshot(rt, 'r').bots[0].status, 'attention')
  rt.approvalsView = () => []
  rt.state.questions['group-2'] = { text: 'PRIVATE' }
  assert.equal(directorySnapshot(rt, 'r').bots[0].status, 'attention')
  rt.readOnly = () => 'another writer'
  assert.equal(directorySnapshot(rt, 'r').bots[0].status, 'unknown')
})

test('runtime identity is persistent and concurrent readers agree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-directory-'))
  try {
    const ids = await Promise.all(Array.from({ length: 8 }, () => directoryIdentity(home)))
    assert.equal(new Set(ids).size, 1)
    assert.equal(await directoryIdentity(home), ids[0])
    assert.equal(await readFile(join(home, 'directory-id'), 'utf8'), ids[0])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('service reads the roster without bootstrapping or executing a model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-directory-service-'))
  try {
    const ctx = fakeContext()
    let loads = 0
    install({ ...runtime(), home, ctx, load: async () => { loads++ }, bootstrap: () => assert.fail('must not bootstrap') })
    assert.equal((await ctx.get('botDirectory').snapshot()).bots[0].name, 'Writer')
    assert.equal(loads, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
