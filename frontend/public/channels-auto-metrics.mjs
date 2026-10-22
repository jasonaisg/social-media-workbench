const fields = ["favCount", "forwardCount", "likeCount"];
const valid = value => Number.isSafeInteger(value) && value >= 0;

export function listMetrics(feed, now = Math.floor(Date.now() / 1000)) {
  const counts = Object.fromEntries(fields.filter(key => valid(feed[key])).map(key => [key, feed[key]]));
  return {
    counts, source: "feed/list",
    status: fields.every(key => valid(counts[key])) ? "ok" : "partial",
    ...(Object.keys(counts).length ? { fetched_at: now, field_fetched_at: Object.fromEntries(Object.keys(counts).map(key => [key, now])) } : {}),
  };
}

export function mergeLiveMetrics(previous = {}, fresh = {}) {
  const counts = { ...previous.counts };
  for (const [key, value] of Object.entries(fresh.counts || {})) if (valid(value)) counts[key] = value;
  return {
    ...previous, ...fresh, counts,
    field_fetched_at: { ...previous.field_fetched_at, ...fresh.field_fetched_at },
    local_downloaded: previous.local_downloaded,
  };
}

// One active detail request. Changing authors discards queued work and aborts
// the active request; generation checks also reject late, uncancellable replies.
export function createMetricsQueue({ request, onChange, canRun = () => true }) {
  let generation = 0, active = null, pending = [], stopped = false;
  const seen = new Set();
  async function pump() {
    if (stopped || active || !pending.length || !canRun()) return;
    const feed = pending.shift(), id = String(feed.id), token = generation;
    const controller = new AbortController();
    active = controller;
    onChange(id, { auto_state: "loading", error: "" });
    try {
      const fresh = await request(feed, controller.signal);
      if (!stopped && token === generation) {
        const complete = fields.every(key => valid(fresh.counts?.[key]));
        onChange(id, { ...fresh, auto_state: complete ? "done" : "partial", error: complete ? "" : "微信详情未返回全部互动数字" });
      }
    } catch (error) {
      if (!stopped && token === generation && !controller.signal.aborted) {
        onChange(id, { auto_state: "failed", error: error.message || "获取失败" });
      }
    } finally {
      if (active === controller) active = null;
      void pump();
    }
  }
  function reset() {
    generation++;
    pending = [];
    seen.clear();
    active?.abort();
  }
  return {
    add(feed, retry = false) {
      const id = String(feed.id || "");
      if (!id || stopped || (!retry && seen.has(id)) || pending.some(item => String(item.id) === id)) return;
      seen.add(id);
      pending.push(feed);
      onChange(id, { auto_state: "queued", error: "" });
      void pump();
    },
    kick: pump,
    reset,
    dispose() { stopped = true; reset(); },
  };
}
