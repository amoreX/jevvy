const path = require('node:path')
const express = require('express')
const { createServer } = require('node:http')
const { Server } = require('socket.io')
const { WorldView } = require('prismarine-viewer/viewer')
const { randomBytes } = require('node:crypto')

module.exports = function startViewer(bot, snapshot, log, agent) {
  const app = express()
  const server = createServer(app)
  const hosts = new Set(['127.0.0.1:3007', 'localhost:3007'])
  const origins = new Set([...hosts].map(host => `http://${host}`))
  const csrf = randomBytes(24).toString('hex')
  const io = new Server(server, { allowRequest: (req, callback) => callback(null, hosts.has(req.headers.host) && (!req.headers.origin || origins.has(req.headers.origin))) })
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host)) return res.status(403).json({ error: 'Local connections only.' })
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store')
      if (req.headers.origin && !origins.has(req.headers.origin)) return res.status(403).json({ error: 'Origin rejected.' })
      if (req.method !== 'GET' && (req.headers['x-jev-token'] !== csrf || !req.is('application/json'))) return res.status(403).json({ error: 'Reload the viewer before making changes.' })
    }
    next()
  })
  app.use(express.json({ limit: '8kb' }))
  app.use(express.static(path.join(__dirname, 'viewer-public')))
  app.get('/api/status', (req, res) => res.json(snapshot()))
  app.get('/api/agent', (req, res) => res.json({ ...agent.snapshot(), csrf }))
  app.get('/api/actions', (req, res) => {
    try { res.json(agent.availableActions()) }
    catch (error) { res.status(503).json({ error: error.message }) }
  })
  const mutate = (route, handler) => app.post(`/api/${route}`, async (req, res) => {
    try { await handler(req.body); res.json({ ok: true }) }
    catch (error) { res.status(400).json({ error: error.message }) }
  })
  mutate('key', body => agent.configureKey(body.apiKey, body.remember === true))
  mutate('key/forget', () => agent.forgetKey())
  mutate('goals', body => agent.addGoals(body))
  mutate('task', body => {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) throw new Error('Enter a task, up to 2,000 characters.')
    return agent.community ? agent.community.receive('local', body.text, 'local') : agent.submitTask(body.text)
  })
  mutate('goals/remove', body => agent.removeGoal(body.id))
  mutate('run', () => agent.start())
  mutate('pause', () => agent.pause())
  mutate('stop', () => agent.community ? agent.community.stop() : agent.stop())
  mutate('home', () => agent.setHome())
  mutate('look', () => agent.manualLook())
  app.use((error, req, res, next) => res.status(400).json({ error: 'Invalid request body.' }))

  io.on('connection', socket => {
    let worldView
    function position() {
      if (!bot.entity) return
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch })
      worldView?.updatePosition(bot.entity.position).catch(error => log('viewer_error', { reason: error.message }))
    }
    function bindWorld() {
      if (!bot.entity || !bot.world) return
      if (worldView) {
        worldView.removeListenersFromBot(bot)
        socket.removeAllListeners('mouseClick')
      }
      socket.emit('version', bot.version)
      worldView = new WorldView(bot.world, 4, bot.entity.position, socket)
      worldView.listenToBot(bot)
      worldView.init(bot.entity.position).catch(error => log('viewer_error', { reason: error.message }))
      position()
    }
    bindWorld()
    bot.on('move', position)
    bot.on('spawn', bindWorld)
    socket.emit('status', snapshot())
    socket.on('disconnect', () => {
      bot.removeListener('move', position)
      bot.removeListener('spawn', bindWorld)
      worldView?.removeListenersFromBot(bot)
    })
  })
  const ticker = setInterval(() => { io.emit('status', snapshot()); io.emit('agent', agent.snapshot()) }, 1000)
  bot.on('end', () => { clearInterval(ticker); io.close(); server.close() })
  server.on('error', error => {
    clearInterval(ticker)
    log('viewer_error', { reason: error.message })
  })
  server.listen(3007, '127.0.0.1', () => log('viewer_ready', { url: 'http://127.0.0.1:3007' }))
}
