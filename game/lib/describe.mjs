// SPDX-License-Identifier: MIT
// The core's wording for the model: what is going on now, how a piece of work
// ended, and the summary that `run`, `cancel`, `status` and `wait` print.
export const text = value => (typeof value === 'string' ? value : JSON.stringify(value))

export const errorText = error => error?.message ?? String(error)

export function describeController (ctrl) {
  if (!ctrl) return '无'
  return { task: `任务 ${ctrl.name}`, service: `服务 ${ctrl.name}`, idle: 'idle' }[ctrl.kind] ?? ctrl.name
}

export function describeNow ({ alive, work, controller }) {
  if (!alive) return '角色已死亡，等待重生'
  const doing = work?.status === 'running' ? `工作 ${work.id} 进行中（第 ${work.attempts} 次运行）` : '没有工作在进行'
  const stuck = controller?.phase === 'stuck' ? '（不肯退出，需要重启进程）' : ''
  return `${doing}；控制者：${describeController(controller)}${stuck}`
}

export function endWord (w) {
  const r = w.result ?? {}
  if (r.ok) return '完成'
  if (r.ended === 'death') return `因死亡结束（${r.where}）`
  if (r.ended === 'cancelled') return r.reason && r.reason !== '已取消' ? `已取消（${r.reason}）` : '已取消'
  if (r.ended === 'replaced') return '被新工作替换'
  if (r.stoppedBy) return `被 ${r.stoppedBy} 接管后结束（${r.reason}）`
  return `失败：${r.error}`
}

export function summarizeWork (w) {
  return {
    id: w.id,
    file: w.file,
    args: w.args,
    status: w.status,
    attempts: w.attempts,
    seconds: Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 100) / 10,
    ...(w.result ?? {}),
    end: w.status === 'ended' ? endWord(w) : undefined,
    position: w.position ?? undefined,
    log: w.log.length ? w.log : undefined
  }
}

export function formatSummary (s) {
  const lines = [`${s.id} ${s.end ?? '进行中'}（${s.seconds} 秒，运行 ${s.attempts} 次）`]
  if (s.ok && s.value !== undefined) lines.push(`结果：${text(s.value)}`)
  if (s.service) lines.push(`接管服务：${s.service}`)
  if (s.position) lines.push(`位置：${s.position.join(' ')}`)
  if (s.log) lines.push(`任务输出（最后 ${s.log.length} 行）：`, ...s.log.map(l => `  ${l}`))
  return lines.join('\n')
}

export const formatWork = w => formatSummary(summarizeWork(w))
