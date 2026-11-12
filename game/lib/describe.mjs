// SPDX-License-Identifier: MIT
// The core's wording for the model: what is going on now, how a job
// ended, and the summary that `run`, `cancel`, `status` and `wait` print.
export const text = value => (typeof value === 'string' ? value : JSON.stringify(value))

export const errorText = error => error?.message ?? String(error)

export function describeController (ctrl) {
  if (!ctrl) return 'none'
  return { task: `task ${ctrl.name}`, reflex: `reflex ${ctrl.name}`, idle: 'idle' }[ctrl.kind] ?? ctrl.name
}

export function describeNow ({ alive, job, controller }) {
  if (!alive) return 'the character is dead, waiting to respawn'
  const doing = job?.status === 'running' ? `job ${job.id} running (attempt ${job.attempts})` : 'no job running'
  const stuck = controller?.phase === 'stuck' ? ' (will not exit; main needs a restart)' : ''
  return `${doing}; controller: ${describeController(controller)}${stuck}`
}

export function endWord (j) {
  const r = j.result ?? {}
  if (r.ok) return 'done'
  if (r.ended === 'death') return `ended by death at ${r.where}`
  if (r.ended === 'cancelled') return r.reason && r.reason !== 'cancelled' ? `cancelled (${r.reason})` : 'cancelled'
  if (r.ended === 'replaced') return 'replaced by a new job'
  if (r.preemptedBy) return `ended after ${r.preemptedBy} preempted it (${r.reason})`
  return `failed: ${r.error}`
}

export function summarizeJob (j) {
  return {
    id: j.id,
    file: j.file,
    args: j.args,
    status: j.status,
    attempts: j.attempts,
    seconds: Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 100) / 10,
    ...(j.result ?? {}),
    end: j.status === 'ended' ? endWord(j) : undefined,
    position: j.position ?? undefined,
    log: j.log.length ? j.log : undefined
  }
}

export function formatSummary (s) {
  const lines = [`${s.id} ${s.end ?? 'running'} (${s.seconds} s, ${s.attempts} ${s.attempts === 1 ? 'attempt' : 'attempts'})`]
  if (s.ok && s.value !== undefined) lines.push(`result: ${text(s.value)}`)
  if (s.reflex) lines.push(`reflex ${s.preemptedBy} ${s.reflex}`)
  if (s.position) lines.push(`position: ${s.position.join(' ')}`)
  if (s.log) lines.push(`task output (last ${s.log.length} ${s.log.length === 1 ? 'line' : 'lines'}):`, ...s.log.map(l => `  ${l}`))
  return lines.join('\n')
}

export const formatJob = j => formatSummary(summarizeJob(j))
