const fs = require('node:fs')
const path = require('node:path')

function load(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    return fallback
  }
}
function write(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity

class WorldMemory {
  constructor(runtime, world) {
    this.file = path.join(runtime, 'world-memory.json')
    this.journal = path.join(runtime, 'world-events.jsonl')
    this.data = load(this.file, { version: 1, world, players: {}, places: {}, episodes: [], skills: {} })
    if (this.data.world !== world) throw new Error('Memory belongs to another Minecraft server.')
    this.dirty = false
  }

  record(type, details) {
    const event = { at: new Date().toISOString(), type, ...details }
    this.data.episodes.push(event)
    this.data.episodes = this.data.episodes.slice(-500)
    // The journal keeps older events while recall stays bounded and fast.
    if (fs.existsSync(this.journal) && fs.statSync(this.journal).size > 20 * 1024 * 1024) fs.renameSync(this.journal, `${this.journal}.${Date.now()}`)
    fs.appendFileSync(this.journal, JSON.stringify(event) + '\n', { mode: 0o600 })
    this.dirty = true
    return event
  }

  player(name) {
    if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) return null
    if (!Object.hasOwn(this.data.players, name)) Object.defineProperty(this.data.players, name, { value: { name, facts: [], conversations: [], helped: 0 }, enumerable: true, writable: true, configurable: true })
    return this.data.players[name]
  }

  chat(name, text, position, own = false) {
    const player = this.player(name)
    if (!player) return
    const event = this.record(own ? 'reply' : 'chat', { player: name, text: text.slice(0, 2000), position })
    player.conversations.push(event)
    player.conversations = player.conversations.slice(-24)
    player.lastSpoke = event.at
    this.flush()
  }

  remember(name, facts, source) {
    const player = this.player(name)
    if (!player) return
    for (const fact of facts.slice(0, 4)) {
      if (typeof fact !== 'string' || !fact.trim() || player.facts.some(f => f.text === fact)) continue
      player.facts.push({ text: fact.slice(0, 240), source: source.slice(0, 2000), provenance: 'player_report', at: new Date().toISOString() })
    }
    player.facts = player.facts.slice(-80)
    this.dirty = true
    this.flush()
  }

  observe(world) {
    const at = new Date().toISOString()
    this.data.lastPosition = { position: world.position, dimension: world.dimension, at }
    for (const p of world.players || []) {
      const player = this.player(p.name)
      if (player) Object.assign(player, { position: p.position, dimension: world.dimension, lastSeen: at })
    }
    for (const b of world.nearbyBlocks || []) {
      if (!/ore$|_log$|_bed$|chest$|barrel|furnace|crafting_table|water|lava|farmland|wheat|carrots|potatoes/.test(b.name)) continue
      const key = `${world.dimension}:${b.position.x},${b.position.y},${b.position.z}`
      this.data.places[key] = { ...this.data.places[key], name: b.name, position: b.position, dimension: world.dimension, seen: at, provenance: 'observed', stale: false }
    }
    if (Object.keys(this.data.places).length > 2500) {
      this.data.places = Object.fromEntries(Object.entries(this.data.places).sort((a, b) => +!!b[1].owned - +!!a[1].owned || b[1].seen.localeCompare(a[1].seen)).slice(0, 2000))
    }
    this.dirty = true
  }

  own(name, position, dimension) {
    this.data.places[`${dimension}:${position.x},${position.y},${position.z}`] = { name, position, dimension, owned: true, seen: new Date().toISOString(), provenance: 'built_by_jev' }
    this.dirty = true
    this.flush()
  }

  verify(bot) {
    for (const place of Object.values(this.data.places)) {
      if (place.dimension !== bot.game?.dimension || distance(place.position, bot.entity?.position) > 24) continue
      const block = bot.blockAt(require('./planner').vector(place.position))
      if (block && block.name !== place.name && !place.stale) {
        place.stale = true
        place.changedTo = block.name
        place.seen = new Date().toISOString()
        this.dirty = true
      }
    }
  }

  outcome(job, success, evidence) {
    const key = job.tag || job.text
    if (!Object.hasOwn(this.data.skills, key)) Object.defineProperty(this.data.skills, key, { value: { successes: 0, failures: 0 }, enumerable: true, writable: true, configurable: true })
    const stats = this.data.skills[key]
    stats[success ? 'successes' : 'failures']++
    Object.assign(stats, { lastAt: Date.now(), lastResult: String(evidence).slice(0, 500) })
    const player = this.player(job.owner)
    if (success && player) player.helped++
    this.record(success ? 'task_done' : 'task_failed', { player: job.owner, task: job.text, evidence: String(evidence).slice(0, 1000) })
    this.flush()
  }

  recall(name, text, world) {
    const tokens = String(text).toLowerCase().split(/\W+/).filter(t => t.length > 2)
    const matches = value => tokens.some(t => JSON.stringify(value).toLowerCase().includes(t))
    return {
      player: this.data.players[name] || null,
      recentEvents: this.data.episodes.slice(-12),
      relevantPastEvents: this.data.episodes.slice(0, -12).filter(matches).slice(-10),
      places: Object.values(this.data.places).filter(p => p.dimension === world.dimension)
        .sort((a, b) => +matches(b) - +matches(a) || distance(a.position, world.position) - distance(b.position, world.position)).slice(0, 20),
      knownPlayers: Object.values(this.data.players).map(p => ({ name: p.name, position: p.position, lastSeen: p.lastSeen, helped: p.helped })),
      learnedSkills: Object.entries(this.data.skills).slice(-12)
    }
  }

  flush() { if (this.dirty) { write(this.file, this.data); this.dirty = false } }
}

module.exports = { WorldMemory, load, write, distance }
