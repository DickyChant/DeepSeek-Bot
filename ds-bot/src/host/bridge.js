// A small service for authenticated integrations. DS Bot remains the session owner.
import { Service } from '@deepseek-ai/cordis'
import { directoryIdentity } from './directory.js'

const refused = code => Object.assign(new Error(code), { code })
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 256

export class BotBridge extends Service {
  constructor(rt) {
    super(rt.ctx, 'botBridge')
    this.rt = rt
    this.sends = new Map()
    this.controls = new Map()
  }

  async target(input) {
    const rt = this.rt
    await rt.load()
    this.identity ??= directoryIdentity(rt.home).catch(error => { this.identity = undefined; throw error })
    if (!key(input?.botId) || input.runtimeId !== await this.identity) throw refused('bot/target-changed')
    const bot = rt.botOf(input.botId)
    if (!bot) throw refused('bot/not-found')
    return bot
  }

  async chat(input) {
    const bot = await this.target(input)
    const cursor = input.cursor
    if (cursor != null && (!Number.isSafeInteger(cursor.part) || cursor.part < 0 || (cursor.beforeSeq !== undefined && (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0)))) throw refused('bot/invalid')
    const page = await this.rt.chatPage(input.botId, cursor ?? undefined)
    const part = this.rt.partsOf(input.botId)[cursor?.part ?? this.rt.partsOf(input.botId).length - 1]
    const blocks = new Map()
    // Complex cards, attachments and tool arguments stay in DS Bot's own renderer.
    return {
      sendState: this.rt.readOnly() !== undefined ? 'read_only' : bot.kickoff ? 'setup_required' : 'ready',
      sessionId: page.sessionId, cursor: page.cursor,
      items: page.items.filter(item => ['user', 'bot', 'divider'].includes(item.kind)).map(item => {
        const event = `${part.sessionId}:${item.seq ?? item.time}:${item.kind}`
        const block = blocks.get(event) ?? 0
        blocks.set(event, block + 1)
        return {
        id: `${event}:${block}`,
        kind: item.kind, text: typeof item.text === 'string' ? item.text.slice(0, 100000) : '',
      } }),
    }
  }

  async send(input) {
    const bot = await this.target(input)
    const rt = this.rt
    if (rt.readOnly() !== undefined) throw refused('bot/read-only')
    if (bot.kickoff) throw refused('bot/setup-required')
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000 || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw refused('bot/invalid')
    const previous = this.sends.get(input.requestId)
    if (previous) {
      if (previous.botId !== input.botId || previous.text !== input.text) throw refused('bot/request-conflict')
      return previous.result
    }
    // Retain outcomes, including uncertain failures; never replay a send automatically.
    if (this.sends.size >= 1000) this.sends.delete(this.sends.keys().next().value)
    const sessionId = rt.chatOf(bot.id)
    const result = (async () => {
      await rt.ensureCapabilities(sessionId)
      const answer = await rt.ctx.sessionController.prompt({ requestId: input.requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: input.text }] }, AbortSignal.timeout(30000))
      if (answer?.error) throw refused('bot/send-refused')
      return { accepted: true, requestId: input.requestId }
    })()
    this.sends.set(input.requestId, { botId: bot.id, text: input.text, result })
    return result
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
    return this.rt.subscribeFeed((event, data) => {
      if (event === 'revision' || event === 'live') listener('changed', {})
      if (data.botId !== input.botId) return
      if (event === 'message') listener('changed', {})
      if (event === 'stream' && data.sessionId !== this.rt.chatOf(input.botId)) return
      if (event === 'stream') listener('stream', {
        attemptId: data.attemptId, sessionId: data.sessionId,
        ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
        ...(typeof data.text === 'string' ? { text: data.text.slice(0, 100000) } : {}),
      })
    })
  }
}

export function install(rt) { new BotBridge(rt) }
