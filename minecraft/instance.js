const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const runtime = path.join(__dirname, 'runtime')
const pidPath = path.join(runtime, 'jev.pid')

function runningPid() {
  const servicePath = path.join(runtime, 'service.pid')
  const activePath = fs.existsSync(servicePath) ? servicePath : pidPath
  if (!fs.existsSync(activePath)) return null
  const pid = Number(fs.readFileSync(activePath, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runtime/jev.pid')
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return null
    throw error
  }
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
  if (command !== 'minecraft-jev') throw new Error(`PID ${pid} belongs to ${command}, not Jev`)
  return pid
}

async function main() {
  const action = process.argv[2]
  const pid = runningPid()
  if (action === 'start') {
    if (pid) return console.log(`Jev is already running (PID ${pid}).`)
    fs.mkdirSync(runtime, { recursive: true })
    const logPath = path.join(runtime, 'jev.log')
    const output = fs.openSync(logPath, 'a')
    const child = spawn(process.execPath, [path.join(__dirname, 'supervisor.js')], {
      cwd: __dirname, detached: true, stdio: ['ignore', output, output]
    })
    child.on('error', error => { console.error(error); process.exitCode = 1 })
    child.unref()
    fs.closeSync(output)
    console.log(`Started Jev process (PID ${child.pid}). Log: ${logPath}`)
    console.log('Run npm run status to check the connection.')
  } else if (action === 'stop') {
    if (!pid) return console.log('Jev is already stopped.')
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 25; i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (!runningPid()) return console.log('Jev disconnected and stopped.')
    }
    throw new Error('Jev has not stopped yet; inspect runtime/jev.log')
  } else if (action === 'status') {
    console.log(pid ? `Jev process is running (PID ${pid}).` : 'Jev process is stopped.')
    const statusPath = path.join(runtime, 'status.json')
    if (fs.existsSync(statusPath)) console.log(fs.readFileSync(statusPath, 'utf8'))
    if (!pid) process.exitCode = 1
  } else {
    throw new Error('Usage: node instance.js start|stop|status')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
