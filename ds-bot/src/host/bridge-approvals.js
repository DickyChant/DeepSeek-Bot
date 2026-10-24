// Participate in DSH's public Remote event protocol as another owner UI.
// DSH arbitrates competing answers and cancels the other UIs' pending cards.
import { randomUUID } from 'node:crypto'

export class BridgeApprovals {
  constructor(rt) {
    this.rt = rt
    this.pending = new Map()
    this.watchers = new Map()
  }

  async watch(botId) {
    this.watchers.set(botId, (this.watchers.get(botId) ?? 0) + 1)
    try { await this.start() } catch { /* Other bridge capabilities remain available. */ }
    return () => {
      const count = (this.watchers.get(botId) ?? 1) - 1
      if (count) this.watchers.set(botId, count)
      else this.watchers.delete(botId)
      for (const entry of this.pending.values()) {
        if (!this.watchers.has(entry.botId)) void this.result(entry.id, { kind: 'next' }).catch(() => {})
      }
      if (!this.watchers.size) this.close()
    }
  }

  async start() {
    if (this.starting) return this.starting
    if (!this.rt.ctx.connection || !this.rt.ctx.get('typertGateway')) return
    const peer = this.rt.ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
    this.peer = peer
    this.starting = (async () => {
      const stream = await this.rt.ctx.get('typertGateway').wireStream.open('$events', { args: {} }, (async function* () {})(), peer, peer.signal)
      const iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.value?.type !== 'ready') throw new Error('Approval stream unavailable')
      this.clientId = first.value.clientId
      void (async () => {
        try {
          for (;;) {
            const { value: frame, done } = await iterator.next()
            if (done) break
            if (frame.type === 'cancel') this.pending.delete(frame.eventId)
            if (frame.type !== 'waterfall') continue
            const botId = this.rt.chatOwners.get(frame.agentId)
            if (frame.event !== 'approval/request' || !botId || !this.watchers.has(botId)) {
              await this.result(frame.eventId, { kind: 'next' })
              continue
            }
            this.pending.set(frame.eventId, {
              id: frame.eventId, botId, sessionId: frame.agentId,
              tool: String(frame.request.toolName ?? '').slice(0, 256),
              reason: String(frame.request.reason ?? '').slice(0, 4000),
              detail: this.rt.callDetail?.(frame.agentId, frame.request.callId) ?? {},
              answerable: true,
            })
          }
        } catch { /* A disconnected stream withdraws its pending requests. */ }
        finally { if (this.peer === peer) this.close() }
      })()
    })().catch(error => { this.close(); throw error })
    return this.starting
  }

  async result(eventId, outcome) {
    const peer = this.peer
    if (!peer || !this.clientId) throw new Error('Approval stream unavailable')
    const handler = this.rt.ctx.connection.createSharedFetchHandler('/api')
    const response = await handler.fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: this.clientId, eventId, outcome } } }),
    }), peer)
    const envelope = await response.json()
    if (!response.ok || envelope.result?.ok !== true) throw new Error('Approval answer unavailable')
    this.pending.delete(eventId)
  }

  close() {
    const peer = this.peer
    this.peer = undefined
    this.clientId = undefined
    this.starting = undefined
    this.pending.clear()
    void peer?.dispose().catch(() => {})
  }
}
