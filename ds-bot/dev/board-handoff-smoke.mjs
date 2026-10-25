// End-to-end handoff check on an explicitly named mock bench, never the user's DSH.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const [name, port, mode = 'send'] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '') || port === '3080') throw Error('Use a mock bench name and non-production port')
const home = resolve(import.meta.dirname, '../..', `.dsh-test-${name}`)
const credential = readFileSync(join(home, 'handoff-fixture/token'), 'utf8').trim()
const fixture = join(home, 'handoff-smoke.json')
const count = () => readFileSync(join(home, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).length
const call = async (request, action) => {
  const response = await fetch(`http://127.0.0.1:${port}/herdr-bots/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify({ ...request, action }) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
let request
if (mode === 'send') {
  const state = JSON.parse(readFileSync(join(home, 'bot/state.json'), 'utf8'))
  const chief = Object.values(state.bots).find(bot => bot.name === 'Chief')
  request = { id: randomUUID(), boardId: 'mock-board', taskId: `fixture/${Date.now()}`, runtimeId: readFileSync(join(home, 'bot/directory-id'), 'utf8').trim(), botId: chief.id, scope: 'Give a short design review report.', origin: 'boss', end: 'report_once', hop: 1 }
  writeFileSync(fixture, JSON.stringify(request), { mode: 0o600 })
  await call(request, 'create')
  const until = Date.now() + 45000
  let result
  do {
    result = await call(request, 'status')
    if (result.state === 'reported') break
    await new Promise(r => setTimeout(r, 250))
  } while (Date.now() < until)
  assert.equal(result.state, 'reported', JSON.stringify(result))
  assert.equal(result.report.origin, 'chief'); assert.equal(result.report.hop, 2)
  assert.ok(result.report.text.length > 0)
  console.log('Mock handoff: request delivered and correlated report received.')
} else {
  request = JSON.parse(readFileSync(fixture, 'utf8'))
  assert.equal((await call(request, 'status')).state, 'reported')
}
const before = count()
assert.equal((await call(request, 'create')).state, 'reported')
assert.equal(count(), before)
console.log('Mock handoff: duplicate create returns the stored report without another model call.')
