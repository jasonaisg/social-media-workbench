// Keep WeChat's distinct counters; never infer zeros from missing/list data.
export function readMetrics(raw) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return data?.wxchannels_metrics || null;
  } catch { return null; }
}
export function metricsText(m) {
  const counts = m?.counts || {};
  const number = key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key].toLocaleString('zh-CN') : '未获取';
  return `点赞（拇指） ${number('favCount')} · 转发 ${number('forwardCount')} · 推荐（爱心） ${number('likeCount')}`;
}
export function metricsNote(m) {
  if (!m) return '尚未获取作品详情数据';
  const time = m.fetched_at ? new Date(m.fetched_at * 1000).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) : '';
  return [m.status === 'failed' ? '更新失败，保留上次数据' : m.status === 'partial' ? '部分指标未返回，旧值保留' : '', time && `更新 ${time}`].filter(Boolean).join(' · ');
}
