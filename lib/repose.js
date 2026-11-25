// memory_repose：把一条 episode 安放到后面（以后不用想得那么详细），或撤销标记。
// 只写 episode_detail 旁表；episodes_v2 的既有列与正文完全不动。
function parseSeq(value) {
  const s = String(value ?? '').trim().replace(/^#/, '')
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function receiptLabel(ep) {
  const text = String(ep?.title || ep?.summary || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const chars = [...text]
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : text
}

/**
 * @param {object} handle openDb 返回的 handle
 * @param {{seq:string|number, simplified?:boolean, reason?:string}} args
 * @returns {string} 很短的收执，不回正文
 */
export function reposeView(handle, args = {}) {
  const rawSeqs = args?.seqs
  const batch = rawSeqs !== undefined
  if (batch && !Array.isArray(rawSeqs)) return 'seqs 需要是 #编号数组'
  if (batch && rawSeqs.length === 0) return 'seqs 至少需要一个 #编号'
  if (batch && rawSeqs.length > 20) return `一次最多 20 条，收到 ${rawSeqs.length} 条`
  const values = batch ? rawSeqs : [args?.seq]
  if (!batch && parseSeq(values[0]) == null) return '需要记忆的 #编号（episode 的 start_seq）'
  const simplified = args?.simplified !== false
  const reason = args?.reason == null ? null : String(args.reason).replace(/\s+/g, ' ').trim().slice(0, 200) || null
  const lines = []
  for (const value of values) {
    const seq = parseSeq(value)
    if (seq == null) {
      if (batch) { lines.push(`没找到：#${String(value ?? '')}`); continue }
      return '需要记忆的 #编号（episode 的 start_seq）'
    }
    const ep = handle.getEpisodeByStartSeq(seq)
    if (!ep) {
      if (batch) { lines.push(`没找到：#${seq}`); continue }
      return `没有这条记忆：#${seq}`
    }
    handle.setEpisodeDetail({
      episodeId: String(ep.start_seq),
      sessionId: ep.session_id,
      simplified,
      reason,
      updatedAt: Date.now(),
    })
    handle.journal('memory-repose', {
      episode_id: String(ep.start_seq),
      simplified,
      reason,
    })
    if (batch) {
      lines.push(simplified
        ? `安放好了：#${ep.start_seq}${reason ? ` · ${reason}` : ''}`
        : `撤销了：#${ep.start_seq}`)
    } else {
      const label = receiptLabel(ep)
      const head = simplified ? '安放好了' : '撤销了'
      const suffix = reason ? reason : label
      lines.push(`${head}：#${ep.start_seq}${suffix ? ` · ${suffix}` : ''}`)
    }
  }
  return lines.join('\n')
}
