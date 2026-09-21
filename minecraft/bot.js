const fs = require('node:fs')
const path = require('node:path')
require('./protocol-fix')()
const mineflayer = require('mineflayer')
const config = require('./config.json')

const runtime = path.join(__dirname, 'runtime')
const pidPath = path.join(runtime, 'jev.pid')
const statePath = path.join(runtime, 'status.json')
fs.mkdirSync(runtime, { recursive: true })
if (fs.existsSync(pidPath)) {
  const pid = Number(fs.readFileSync(pidPath, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runtime/jev.pid')
  try {
    process.kill(pid, 0)
    throw new Error(`Jev is already running as PID ${pid}`)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    fs.unlinkSync(pidPath)
  }
}
fs.writeFileSync(pidPath, String(process.pid), { flag: 'wx' })
process.title = 'minecraft-jev'
process.on('exit', () => {
  if (fs.existsSync(pidPath) && fs.readFileSync(pidPath, 'utf8') === String(process.pid)) {
    fs.unlinkSync(pidPath)
  }
})

const startedAt = new Date().toISOString()
let phase = 'connecting'
let lastPacketAt = null
let packetsReceived = 0
let chunksReceived = 0
let stopping = false
let failure = null
let navigation = {}

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }))
}

log('connecting', config)
const bot = mineflayer.createBot({ ...config, hideErrors: true })
bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
bot.loadPlugin(require('mineflayer-tool').plugin)
bot.loadPlugin(require('mineflayer-collectblock').plugin)
let agent
let survivalMode
bot.once('inject_allowed', () => {
  require('./entity-compat')(bot)
  require('./bamboo-collision').installBambooCollision(bot)
  survivalMode = require('./survival-mode')(bot, log)
  agent = new (require('./agent').Agent)(bot, runtime, log)
  new (require('./agent/community').Community)(agent, runtime, { world: `${config.host}:${config.port}` })
  require('./viewer-server')(bot, snapshot, log, agent)
})

function snapshot() {
  return {
    updatedAt: new Date().toISOString(), startedAt, pid: process.pid,
    phase, host: config.host, port: config.port, username: config.username,
    version: bot.version || config.version, protocol: bot.protocolVersion,
    position: bot.entity?.position, dimension: bot.game?.dimension,
    gameMode: bot.game?.gameMode, effects: bot.entity?.effects || {},
    survivalMode,
    navigation: { ...navigation, moving: bot.pathfinder?.isMoving(), mining: bot.pathfinder?.isMining(), controls: bot.controlState, velocity: bot.entity?.velocity },
    health: bot.health, food: bot.food,
    players: Object.keys(bot.players || {}),
    chunksReceived, packetsReceived, lastPacketAt, failure
  }
}

function save() {
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(snapshot(), null, 2) + '\n')
  fs.renameSync(`${statePath}.tmp`, statePath)
}

save()
const heartbeat = setInterval(save, 10000)
const connectTimeout = setTimeout(() => {
  failure = 'No spawn event within 60 seconds'
  log('connection_timeout', { reason: failure })
  bot.end(failure)
}, 60000)

bot._client.on('packet', () => {
  packetsReceived++
  lastPacketAt = new Date().toISOString()
})
bot.on('login', () => {
  phase = 'logged_in'
  log('login', { username: bot.username, version: bot.version })
  save()
})
bot.on('spawn', () => {
  clearTimeout(connectTimeout)
  phase = 'spawned'
  log('spawn', snapshot())
  save()
})
bot.on('chunkColumnLoad', () => { chunksReceived++ })
bot.on('path_update', result => {
  navigation = { updatedAt: new Date().toISOString(), status: result.status, length: result.path.length,
    next: result.path.slice(0, 6).map(({ x, y, z, toBreak, toPlace }) => ({ x, y, z, toBreak, toPlace })) }
})
bot.on('path_reset', reason => { navigation.lastReset = reason })
bot.on('health', save)
bot.on('playerJoined', player => log('player_joined', { username: player.username }))
bot.on('playerLeft', player => log('player_left', { username: player.username }))
bot.on('death', () => {
  phase = 'dead'
  log('death')
  save()
})
bot.on('kicked', reason => {
  failure = typeof reason === 'string' ? reason : JSON.stringify(reason)
  log('kicked', { reason: failure })
  save()
})
bot.on('error', error => {
  failure = error.stack || error.message
  log('error', { reason: failure })
  save()
})
bot.on('end', reason => {
  phase = 'disconnected'
  clearInterval(heartbeat)
  clearTimeout(connectTimeout)
  log('disconnected', { reason, requested: stopping })
  save()
  // Let the agent and memory listeners save interrupted work before exit.
  setImmediate(() => process.exit(stopping ? 0 : 1))
})

function stop() {
  if (stopping) return
  stopping = true
  log('stopping')
  agent?.community?.close()
  agent?.pause('Jev is stopping.')
  bot.quit()
  setTimeout(() => {
    phase = 'stopped'
    save()
    process.exit(0)
  }, 3000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
