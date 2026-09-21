module.exports = function taskInput(socket) {
  const form = document.getElementById('task-form')
  const input = document.getElementById('task-text')
  const button = document.getElementById('task-submit')
  const status = document.getElementById('task-status')
  let csrf = ''
  let busy = false
  let sending = false
  let connected = false
  let localError = null

  function controls() {
    button.textContent = sending ? '…' : busy && !input.value.trim() ? 'Stop' : 'Do it'
    button.disabled = sending || !connected
    input.readOnly = sending
  }

  function render(data) {
    busy = data.busy
    connected = true
    status.textContent = localError || data.currentAction || data.message
    controls()
  }

  async function refresh() {
    const response = await fetch('/api/agent')
    if (!response.ok) throw new Error('Cannot reach Jev.')
    const data = await response.json()
    csrf = data.csrf
    render(data)
  }

  form.onsubmit = async event => {
    event.preventDefault()
    if (sending || !connected) return
    const text = input.value.trim()
    const stopping = busy && !text
    if (!stopping && !text) return input.focus()
    localError = null
    sending = true
    controls()
    try {
      if (!csrf) await refresh()
      const response = await fetch(`/api/${stopping ? 'stop' : 'task'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jev-Token': csrf },
        body: JSON.stringify(stopping ? {} : { text }), signal: AbortSignal.timeout(30000)
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not start the task.')
      if (!stopping) input.value = ''
      await refresh()
    } catch (error) { localError = error.message; status.textContent = localError }
    finally { sending = false; controls() }
  }
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit()
    }
  }
  input.oninput = controls
  socket.on('agent', render)
  socket.on('connect', () => refresh().catch(error => { status.textContent = error.message }))
  socket.on('disconnect', () => {
    connected = false
    csrf = ''
    status.textContent = 'Reconnecting to Jev…'
    controls()
  })
  refresh().catch(error => { status.textContent = error.message })
}
