// SPDX-License-Identifier: MIT
// The core's wording for the model: what is going on now, how a job
// ended, and the summary that `run`, `cancel`, `status` and `wait` print.
export const text = value => (typeof value === 'string' ? value : JSON.stringify(value))

export const errorText = error => error?.message ?? String(error)

export function describeController (ctrl) {
  if (!ctrl) return '无'
  return { task: `任务 ${ctrl.name}`, reflex: `反射 ${ctrl.name}`, idle: 'idle' }[ctrl.kind] ?? ctrl.name
}

export function describeNow ({ alive, job, controller }) {
  if (!alive) return '角色已死亡，等待重生'
  const doing = job?.status === 'running' ? `作业 ${job.id} 进行中（第 ${job.attempts} 次尝试）` : '没有作业在进行'
  const stuck = controller?.phase === 'stuck' ? '（不肯退出，需要重启进程）' : ''
  return `${doing}；控制者：${describeController(controller)}${stuck}`
}

export function endWord (j) {
  const r = j.result ?? {}
  if (r.ok) return '完成'
  if (r.ended === 'death') return `因死亡结束（${r.where}）`
  if (r.ended === 'cancelled') return r.reason && r.reason !== '已取消' ? `已取消（${r.reason}）` : '已取消'
  if (r.ended === 'replaced') return '被新作业替换'
  if (r.preemptedBy) return `被 ${r.preemptedBy} 抢占后结束（${r.reason}）`
  return `失败：${r.error}`
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
  const lines = [`${s.id} ${s.end ?? '进行中'}（${s.seconds} 秒，尝试 ${s.attempts} 次）`]
  if (s.ok && s.value !== undefined) lines.push(`结果：${text(s.value)}`)
  if (s.reflex) lines.push(`抢占的反射：${s.reflex}`)
  if (s.position) lines.push(`位置：${s.position.join(' ')}`)
  if (s.log) lines.push(`任务输出（最后 ${s.log.length} 行）：`, ...s.log.map(l => `  ${l}`))
  return lines.join('\n')
}

export const formatJob = j => formatSummary(summarizeJob(j))
