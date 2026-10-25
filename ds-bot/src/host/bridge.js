// A small service for authenticated integrations. DS Bot remains the session owner.
import { BoardHandoffs } from './board-handoffs.js'
import { randomUUID } from 'node:crypto'
import { BridgeApprovals } from './bridge-approvals.js'
import { Service } from '@deepseek-ai/cordis'
import { directoryIdentity } from './directory.js'

const refused = code => Object.assign(new Error(code), { code })
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 256

export class BotBridge extends Service {
  constructor(rt) {
    super(rt.ctx, 'botBridge')
    this.rt = rt
    this.boardHandoffs = new BoardHandoffs(rt, input => this.target(input))
    this.sends = new Map()
    this.controls = new Map()
    this.files = new Map()
    this.approvalEvents = new BridgeApprovals(rt)
    rt.ctx.effect(() => () => this.approvalEvents.close(), 'ds-bot: bridge approvals')
  }

  async handoff(input) { return this.boardHandoffs.call(input) }

  async target(input) {
    const rt = this.rt
    await rt.load()
    this.identity ??= directoryIdentity(rt.home).catch(error => { this.identity = undefined; throw error })
    if (!key(input?.botId) || input.runtimeId !== await this.identity) throw refused('bot/target-changed')
    const bot = rt.botOf(input.botId)
    if (!bot) throw refused('bot/not-found')
    return bot
  }

  room(input) {
    if (input.roomId === undefined) return undefined
    const room = key(input.roomId) ? this.rt.roomOf(input.roomId) : undefined
    if (!room || !room.members.includes(input.botId)) throw refused('bot/target-changed')
    return room
  }

  filesView(input, files = []) {
    return files.slice(0, 8).filter(file => file && key(file.attachmentId) && Number.isSafeInteger(file.bytes)).map(file => {
      const id = randomUUID()
      if (this.files.size >= 2000) this.files.delete(this.files.keys().next().value)
      this.files.set(id, { botId: input.botId, roomId: input.roomId, file, until: Date.now() + 900000 })
      return { id, name: String(file.name ?? 'attachment').slice(0, 256), bytes: file.bytes }
    })
  }

  async chat(input) {
    const bot = await this.target(input)
    const room = this.room(input)
    if (room) return {
      sessionId: room.id, sendState: this.rt.readOnly() !== undefined ? 'read_only' : 'ready', cursor: null,
      recent: true,
      items: (room.log ?? []).slice(-60).map(line => ({
        id: `${room.id}:${line.seq}`, kind: line.botId || line.kind ? 'bot' : 'user',
        name: String(line.who ?? '').slice(0, 256), text: `${String(line.text || line.kind || '').slice(0, 100000)}${line.length > (line.text?.length ?? 0) ? '…' : ''}`,
        files: this.filesView(input, line.files),
      })),
    }
    const cursor = input.cursor
    if (cursor != null && (!Number.isSafeInteger(cursor.part) || cursor.part < 0 || (cursor.beforeSeq !== undefined && (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0)))) throw refused('bot/invalid')
    const page = await this.rt.chatPage(input.botId, cursor ?? undefined)
    const part = this.rt.partsOf(input.botId)[cursor?.part ?? this.rt.partsOf(input.botId).length - 1]
    const blocks = new Map()
    // Only displayed conversation content crosses this authenticated boundary.
    return {
      sendState: this.rt.readOnly() !== undefined ? 'read_only' : bot.kickoff ? 'setup_required' : 'ready',
      sessionId: page.sessionId, cursor: page.cursor,
      items: page.items.filter(item => ['user', 'bot', 'divider'].includes(item.kind)).map(item => {
        const event = `${part.sessionId}:${item.seq ?? item.time}:${item.kind}`
        const block = blocks.get(event) ?? 0
        blocks.set(event, block + 1)
        return {
        id: `${event}:${block}`,
        kind: item.kind, files: this.filesView(input, item.files), text: typeof item.text === 'string' ? item.text.slice(0, 100000) : '',
      } }),
    }
  }

  async send(input) {
    const bot = await this.target(input)
    const rt = this.rt
    if (rt.readOnly() !== undefined) throw refused('bot/read-only')
    const room = this.room(input)
    if (!room && bot.kickoff) throw refused('bot/setup-required')
    const receipts = input.receipts ?? []
    if (!Array.isArray(receipts) || receipts.length > 8 || receipts.some(id => !key(id)) || new Set(receipts).size !== receipts.length) throw refused('bot/invalid')
    if (typeof input.text !== 'string' || (!input.text.trim() && !receipts.length) || input.text.length > 32000 || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw refused('bot/invalid')
    const fingerprint = JSON.stringify([input.botId, input.roomId, input.text, receipts, input.sessionId])
    const previous = this.sends.get(input.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw refused('bot/request-conflict')
      return previous.result
    }
    // Retain outcomes, including uncertain failures; never replay a send automatically.
    if (this.sends.size >= 1000) this.sends.delete(this.sends.keys().next().value)
    const sessionId = room?.id ?? rt.chatOf(bot.id)
    if (receipts.length && input.sessionId !== sessionId) throw refused('bot/target-changed')
    const result = (async () => {
      await rt.ensureCapabilities(sessionId)
      const answer = await rt.ctx.sessionController.prompt({ requestId: input.requestId, sessionId, mode: 'queue', content: [...(input.text.trim() ? [{ type: 'text', text: input.text }] : []), ...receipts.map(receiptId => ({ type: 'file', receiptId }))] }, AbortSignal.timeout(30000))
      if (answer?.error) throw refused('bot/send-refused')
      return { accepted: true, requestId: input.requestId }
    })()
    this.sends.set(input.requestId, { fingerprint, result })
    return result
  }

  async upload(input) {
    const bot = await this.target(input)
    const room = this.room(input)
    if (this.rt.readOnly() !== undefined) throw refused('bot/read-only')
    const sessionId = room?.id ?? this.rt.chatOf(bot.id)
    if (input.sessionId !== sessionId) throw refused('bot/target-changed')
    if (!key(input.name) || typeof input.data !== 'string' || input.data.length > 13981016) throw refused('bot/invalid')
    const data = Buffer.from(input.data, 'base64')
    if (data.length > 10485760 || data.toString('base64') !== input.data) throw refused('bot/invalid')
    const agent = await this.rt.resolveAgent(sessionId)
    const value = await this.rt.ctx.get('fileUploads').upload(agent, { name: input.name, data: input.data }, AbortSignal.timeout(30000))
    return { sessionId, receiptId: value.receiptId, name: value.file.name, bytes: value.file.bytes }
  }

  async download(input) {
    await this.target(input)
    this.room(input)
    const entry = this.files.get(input.fileId)
    if (!entry || entry.botId !== input.botId || entry.roomId !== input.roomId || entry.until < Date.now()) throw refused('bot/target-changed')
    if (entry.file.bytes > 10485760) throw refused('bot/file-too-large')
    const chunks = []
    let bytes = 0
    for await (const chunk of this.rt.ctx.get('attachments').readFileStream(entry.file, AbortSignal.timeout(30000))) {
      bytes += chunk.length
      if (bytes > 10485760) throw refused('bot/file-too-large')
      chunks.push(chunk)
    }
    return { name: entry.file.name, data: Buffer.concat(chunks).toString('base64') }
  }

  async approvals(input) {
    await this.target(input)
    const room = this.room(input)
    if (!room && this.approvalEvents.watchers.has(input.botId)) {
      await this.approvalEvents.start()
      if (!this.approvalEvents.clientId) throw refused('bot/approval-unavailable')
    }
    const entries = room
      ? (this.rt.approvalsView?.() ?? []).filter(entry => entry.roomId === room.id)
      : [...this.approvalEvents.pending.values()].filter(entry => entry.botId === input.botId && entry.sessionId === this.rt.chatOf(input.botId))
    return { items: entries.slice(0, 100).map(entry => ({
      id: entry.id, sessionId: entry.sessionId, botId: entry.botId,
      name: this.rt.botOf(entry.botId)?.name ?? '', tool: String(entry.tool).slice(0, 256), reason: String(entry.reason).slice(0, 4000),
      detail: [entry.detail?.text, entry.detail?.code].filter(value => typeof value === 'string').join('\n').slice(0, 20000),
      answerable: entry.answerable === true && this.rt.readOnly() === undefined,
    })) }
  }

  async answer(input) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId) || !['allow', 'reject'].includes(input.choice)) throw refused('bot/invalid')
    const page = await this.approvals(input)
    const entry = page.items.find(entry => entry.id === input.approvalId && entry.sessionId === input.sessionId && entry.answerable)
    if (!entry) throw refused('bot/stale')
    if (input.roomId) this.rt.answerApproval(entry.id, input.choice)
    else await this.approvalEvents.result(entry.id, { kind: 'result', value: input.choice === 'allow' ? 'allowed-once' : 'rejected' })
    return { accepted: true, requestId: input.requestId }
  }

  async settings(input) {
    const bot = await this.target(input)
    const entries = await this.rt.catalog({ fresh: true })
    return {
      model: bot.model ?? null,
      writable: this.rt.readOnly() === undefined,
      working: this.rt.workView()[bot.id] !== undefined,
      sessionId: this.rt.chatOf(bot.id),
      models: entries.slice(0, 2000).map(entry => ({ ref: entry.ref, name: entry.name, provider: entry.providerName, available: !entry.needsKey })),
    }
  }

  async control(input) {
    const bot = await this.target(input)
    const rt = this.rt
    if (rt.readOnly() !== undefined) throw refused('bot/read-only')
    if (!['model', 'stop'].includes(input.action) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw refused('bot/invalid')
    if (input.action === 'model' && !key(input.model)) throw refused('bot/invalid')
    if (input.action === 'stop' && (!key(input.sessionId) || input.sessionId !== rt.chatOf(bot.id))) throw refused('bot/target-changed')
    const fingerprint = JSON.stringify([bot.id, input.action, input.model, input.sessionId])
    const previous = this.controls.get(input.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw refused('bot/request-conflict')
      return previous.result
    }
    const result = (async () => {
      if (input.action === 'model') {
        const entry = (await rt.catalog({ fresh: true })).find(entry => entry.ref === input.model)
        if (!entry || entry.needsKey) throw refused('bot/model-unavailable')
        await rt.updateBot(bot.id, { model: entry.ref })
      } else {
        const agent = await rt.resolveAgent(input.sessionId)
        // Cancel only the displayed direct session, never this Bot's group work.
        if (input.sessionId !== rt.chatOf(bot.id)) throw refused('bot/target-changed')
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      return { accepted: true, requestId: input.requestId }
    })()
    if (this.controls.size >= 1000) this.controls.delete(this.controls.keys().next().value)
    this.controls.set(input.requestId, { fingerprint, result })
    return result
  }

  async subscribe(input, listener) {
    await this.target(input)
    const room = this.room(input)
    const unwatch = room ? () => {} : await this.approvalEvents.watch(input.botId)
    const unsubscribe = this.rt.subscribeFeed((event, data) => {
      if (event === 'revision' || event === 'live') listener('changed', {})
      if (room || data.botId !== input.botId) return
      if (event === 'message') listener('changed', {})
      if (event === 'stream' && data.sessionId !== this.rt.chatOf(input.botId)) return
      if (event === 'stream') listener('stream', {
        attemptId: data.attemptId, sessionId: data.sessionId,
        ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
        ...(typeof data.text === 'string' ? { text: data.text.slice(0, 100000) } : {}),
      })
    })
    return () => { unsubscribe(); unwatch() }
  }
}

export function install(rt) { new BotBridge(rt) }
