const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const runtime = path.join(__dirname, 'runtime')
const file = path.join(runtime, 'service.pid')
process.title = 'minecraft-jev'
if (fs.existsSync(file)) {
  const pid = Number(fs.readFileSync(file, 'utf8'))
  try { process.kill(pid, 0); throw new Error('Jev supervisor is already running.') }
  catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(file) }
}
fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 })
let child, stopping = false, retry, failures = 0
process.on('exit', () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file) })
function connect() {
  const started = Date.now()
  child = spawn(process.execPath, [path.join(__dirname, 'bot.js')], { cwd: __dirname, stdio: 'inherit' })
  child.on('error', error => { console.error(JSON.stringify({ event: 'supervisor_error', reason: error.message })); process.exitCode = 1 })
  child.on('exit', code => {
    if (stopping || code === 0) return process.exit(0)
    failures = Date.now() - started > 60000 ? 0 : failures + 1
    const wait = Math.min(60000, 3000 * 2 ** Math.min(failures, 5))
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'reconnecting', waitMs: wait }))
    retry = setTimeout(connect, wait)
  })
}
function stop() {
  stopping = true
  clearTimeout(retry)
  if (child && child.exitCode === null) child.kill('SIGTERM')
  else process.exit(0)
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
connect()
