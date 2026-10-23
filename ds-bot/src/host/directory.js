// A metadata-only service for local integrations. Conversation text, instructions,
// tool arguments and permission details never cross this boundary.
import { Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function directoryIdentity(home) {
  await mkdir(home, { recursive: true })
  const path = join(home, 'directory-id')
  const temporary = `${path}.${randomUUID()}`
  await writeFile(temporary, randomUUID(), { flag: 'wx', mode: 0o600 })
  try {
    try { await link(temporary, path) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  } finally {
    await unlink(temporary)
  }
  const id = (await readFile(path, 'utf8')).trim()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid Bot directory identity')
  return id
}

export function directorySnapshot(rt, runtimeId, now = Date.now()) {
  const activity = rt.activityView()
  const work = rt.workView()
  const roomWork = rt.roomWorkView()
  const approvals = new Set(rt.approvalsView().map(entry => entry.botId))
  const readable = rt.readOnly() === undefined
  const bots = Object.values(rt.state.bots).map(bot => {
    const conversations = [{
      id: `direct:${bot.id}`, kind: 'direct', name: bot.name,
      currentSessionId: rt.chatOf(bot.id) ?? null,
      sessionIds: rt.partsOf(bot.id).map(part => part.sessionId),
    }]
    for (const room of Object.values(rt.state.rooms)) {
      if (!room.members.includes(bot.id)) continue
      conversations.push({
        id: `group:${room.id}`, kind: 'group', name: room.name,
        currentSessionId: room.sessions?.[bot.id] ?? null,
        sessionIds: rt.partsOf(bot.id, room.id).map(part => part.sessionId),
      })
    }
    const sessions = conversations.flatMap(conversation => conversation.sessionIds)
    const attention = approvals.has(bot.id) || bot.kickoff || sessions.some(id => rt.state.questions[id] || rt.state.views[id])
    const working = work[bot.id] !== undefined || Object.values(roomWork).some(entries => entries.some(entry => entry.botId === bot.id))
    const status = !readable ? 'unknown' : attention || activity[bot.id] === 'alert' ? 'attention'
      : working ? 'working' : activity[bot.id] === 'waiting' ? 'waiting' : 'available'
    return { id: bot.id, name: bot.name, role: bot.role ?? '', status, conversations }
  })
  return { version: 1, runtimeId, observedAt: now, bots }
}

class BotDirectory extends Service {
  constructor(rt) {
    super(rt.ctx, 'botDirectory')
    this.rt = rt
  }

  async snapshot() {
    // Load, never bootstrap: viewing the directory must not create a Bot or run a model.
    await this.rt.load()
    this.identity ??= directoryIdentity(this.rt.home).catch(error => { this.identity = undefined; throw error })
    return directorySnapshot(this.rt, await this.identity)
  }
}

export function install(rt) {
  new BotDirectory(rt)
}
