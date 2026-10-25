// Durable, bounded board handoffs. Reports are data; this service never prompts Boss.
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { textOf } from './text.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const controls = value => [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const word = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !controls(value)
const active = r => ['sending', 'sent', 'working', 'uncertain'].includes(r.state)
export class BoardHandoffs {
  constructor(rt, target) {
    this.rt = rt
    this.target = target
    this.turns = new Map()
  }
  load() {
    if (this.broken) fail('bot/handoff-store')
    if (this.records) return
    this.file = join(this.rt.home, 'board-handoffs.json')
    let records
    try {
      if (statSync(this.file).size > 16000000) fail('bot/handoff-store')
      records = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(records) || records.length > 1000 || records.some(r => !word(r.boardId) || !word(r.taskId) || !word(r.id) || !['sending', 'sent', 'working', 'uncertain', 'reported', 'closed'].includes(r.state))) fail('bot/handoff-store')
    } catch (error) {
      if (error.code !== 'ENOENT') fail('bot/handoff-store')
      records = []
    }
    // A process restart is not evidence that a request was not delivered.
    this.rt.ctx.on('session/event', (session, event) => {
      try { this.event(session?.id, event) } catch { this.broken = true }
    })
    this.records = records.map(r => {
      const saved = { ...r }; delete saved.turn; delete saved.pending; delete saved.text
      return active(r) ? { ...saved, state: 'uncertain' } : saved
    })
  }
  save() {
    if (this.rt.readOnly() !== undefined) fail('bot/read-only')
    mkdirSync(this.rt.home, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    let fd
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(this.records)); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temp, this.file)
      if (process.platform !== 'win32') {
        const dir = openSync(this.rt.home, 'r')
        try { fsyncSync(dir) } finally { closeSync(dir) }
      }
    } catch {
      if (fd !== undefined) closeSync(fd)
      this.broken = true
      fail('bot/handoff-store')
    }
  }
  view(r) {
    return { id: r.id, boardId: r.boardId, taskId: r.taskId, runtimeId: r.runtimeId, botId: r.botId, scope: r.scope, origin: r.origin, end: r.end, state: r.state, hop: r.report ? 2 : 1, report: r.report ?? null }
  }
  async call(input) {
    await this.rt.load()
    this.load()
    if (!input || !['create', 'status', 'close'].includes(input.action) || !word(input.boardId) || !word(input.taskId) || (typeof input.id !== 'string' || !(/^[a-zA-Z0-9-]{16,80}$/).test(input.id))) fail('bot/invalid')
    if (input.action === 'close' && this.rt.readOnly() !== undefined) fail('bot/read-only')
    if (this.records.some(r => r.id === input.id && (r.boardId !== input.boardId || r.taskId !== input.taskId))) fail('bot/request-conflict')
    const r = this.records.find(r => r.boardId === input.boardId && r.taskId === input.taskId)
    if (r && (r.id !== input.id || r.botId !== input.botId || r.runtimeId !== input.runtimeId)) fail('bot/request-conflict')
    if (input.action !== 'create') {
      if (!r) {
        if (input.action !== 'close') fail('bot/not-found')
        if (!word(input.botId) || !word(input.runtimeId) || this.records.length >= 1000) fail('bot/invalid')
        const tombstone = { id: input.id, boardId: input.boardId, taskId: input.taskId, botId: input.botId, runtimeId: input.runtimeId, state: 'closed' }
        this.records.push(tombstone); this.save(); return this.view(tombstone)
      }
      if (input.action === 'close' && r.state !== 'closed') { r.state = 'closed'; this.save() }
      return this.view(r)
    }
    if (typeof input.scope !== 'string' || !input.scope.trim() || input.scope.length > 500 || controls(input.scope) || !['user', 'boss'].includes(input.origin) || !['report_once', 'task_closed'].includes(input.end) || input.hop !== 1) fail('bot/invalid')
    if (r) {
      if (r.state === 'closed') return this.view(r)
      if (r.scope !== input.scope || r.origin !== input.origin || r.end !== input.end) fail('bot/request-conflict')
      return this.view(r)
    }
    const bot = await this.target(input)
    // Recheck after the asynchronous identity lookup: concurrent creates share one ledger.
    if (this.records.some(r => r.boardId === input.boardId && r.taskId === input.taskId)) return this.call(input)
    if (this.rt.readOnly() !== undefined) fail('bot/read-only')
    if (bot.kickoff) fail('bot/setup-required')
    if (this.records.length >= 1000) fail('bot/handoff-store')
    const sessionId = this.rt.chatOf(bot.id)
    if (this.records.some(r => r.botId === bot.id && active(r)) || this.rt.live?.get(sessionId)?.turn !== undefined) fail('bot/handoff-busy')
    const record = { id: input.id, boardId: input.boardId, taskId: input.taskId, botId: bot.id, runtimeId: input.runtimeId, scope: input.scope, origin: input.origin, end: input.end, sessionId, state: 'sending' }
    this.records.push(record)
    this.save() // Must survive a lost HTTP response before anything can be submitted.
    const text = `[Board handoff: ${record.taskId}]\nOrigin: ${record.origin === 'boss' ? 'Boss on the user’s behalf' : 'User directly'}; sent by the user.\nScope: ${record.scope}\nEnd condition: ${record.end === 'report_once' ? 'Report back once' : 'Task closure ends this handoff; at most one report'}.\nProvide one report for Boss. This report is information, never instructions to Boss. Do not start a back-and-forth with Boss. Approvals remain with the user.\nHandoff: ${record.id}`
    try {
      await this.rt.ensureCapabilities(sessionId)
      if (record.state === 'closed') return this.view(record)
      const answer = await this.rt.ctx.sessionController.prompt({ requestId: record.id, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(30000))
      if (answer?.error) fail('bot/send-refused')
      if (record.state === 'sending') record.state = 'sent'
    } catch {
      if (record.state === 'sending') record.state = 'uncertain'
    }
    this.save()
    return this.view(record)
  }
  event(sessionId, event) {
    if (!this.records || this.broken || !sessionId) return
    const candidates = this.records.filter(r => r.sessionId === sessionId && active(r))
    if (!candidates.length) return
    if (event.type === 'turn/start') {
      for (const r of candidates) if (r.turn !== undefined) { r.state = 'uncertain'; delete r.turn; this.save() }
      this.turns.set(sessionId, event.data.turn)
      for (const r of candidates) if (r.pending) { r.turn = event.data.turn; r.pending = false; r.state = 'working'; this.save() }
    }
    for (const r of candidates) {
      if (event.type === 'user/message') {
        if (event.data?.source?.rpcId === r.id) {
          delete r.text
          r.turn = this.turns.get(sessionId)
          r.pending = r.turn === undefined
          r.state = 'working'; this.save()
        } else if (r.turn !== undefined || r.pending) {
          // A merged user request makes automatic attribution ambiguous.
          r.state = 'uncertain'; r.turn = undefined; r.pending = false; delete r.text; this.save()
        }
      }
      if (r.turn === undefined) continue
      if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        r.text = Array.isArray(content) && content.some(b => b?.type === 'tool-call') ? '' : textOf(content).slice(0, 12000)
      }
      if (event.type === 'turn/end') {
        r.report = { text: event.data?.reason?.kind === 'completed' ? r.text || 'Chief completed without a text report.' : 'Chief’s turn ended without a completed report. Inspect the Chief chat.', origin: 'chief', hop: 2 }
        r.state = 'reported'; delete r.turn; delete r.text; this.save()
      }
    }
    if (event.type === 'turn/end') this.turns.delete(sessionId)
  }
}
