import { metricsText, metricsNote } from "./channels-metrics.mjs";
import { listMetrics, mergeLiveMetrics, createMetricsQueue } from "./channels-auto-metrics.mjs";
import { mountArticleSearch } from "./mp-article-search.mjs";
export const template = `
<header class="workbench-header">
  <section class="intro"><p class="eyebrow">WECHAT PLATFORM</p><h1>微信平台</h1><p>按关键词查找不同作者的视频并按点赞排序，或按作者浏览；已下载内容请到账号页查看。</p></section>
  <section class="connection" aria-label="视频号微信连接"><span id="status" role="status" aria-describedby="connection-help">正在检查连接…</span><button id="open-channels" type="button" title="在专用微信中打开可连接的视频号主页">打开视频号</button><button id="check" type="button" title="重新检查视频号微信连接">检查</button><p id="connection-help">请在电脑微信打开或刷新视频号页面，并保持窗口可用。</p></section>
</header>
<div class="content-categories" role="group" aria-label="搜索类别"></div>
<p id="message" role="status" aria-live="polite"></p>
<div class="workspace">
  <section class="panel search-panel" aria-label="视频搜索"><div class="search-modes" role="group" aria-label="搜索方式"><button id="mode-works" type="button" aria-pressed="true">搜作品</button><button id="mode-authors" type="button" aria-pressed="false">查找作者</button></div><form id="search"><label id="search-label" for="keyword">作品关键词或话题</label><div class="search-row"><input id="keyword" required placeholder="例如：人工智能" autocomplete="off"><button id="search-button">搜索</button></div></form><p id="search-hint" class="search-hint">只展示作品文案或话题包含关键词的普通视频；点赞排行随加载更新。</p><div id="authors" class="authors" hidden></div><button id="more-authors" hidden>更多作者</button></section>
  <section class="panel works"><div class="toolbar"><div><h2 id="author-title">关键词作品</h2><p id="count">输入关键词开始搜索</p></div><button id="download" disabled>下载所选（0）</button></div><div class="selection"><label><input type="checkbox" id="select-all" disabled> 全选已加载视频</label><span>每批最多 100 条</span></div><div id="feeds"><p class="empty">搜索后，在这里浏览按点赞排序的作品。</p></div><p id="metrics-status" role="status" aria-live="polite"></p><button id="more-feeds" hidden>加载更多作品</button></section>
</div>
`;

export function contacts(data) {
  const items = [...(data.infoList || []).map(x => x.contact), ...(data.objectList || []).map(x => x.contact)];
  return [...new Map(items.filter(x => x?.username).map(x => [x.username, x])).values()];
}
export function cleanSearchDescription(value) {
  return String(value || "")
    .replace(/<\/?em(?:\s+[^>]*)?>/gi, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&#39;": "'" })[entity.toLowerCase()] || entity)
    .replace(/\s+/g, " ").trim();
}
export function matchesSearchDescription(description, keyword) {
  const query = String(keyword || "").trim().toLocaleLowerCase();
  if (!query) return true;
  const text = cleanSearchDescription(description).toLocaleLowerCase();
  return text.includes(query);
}
export function searchFeeds(data, keyword = "") {
  const rows = [...(Array.isArray(data.objectList) ? data.objectList : []), ...(Array.isArray(data.multiFeedStream) ? data.multiFeedStream : [])];
  const feeds = [];
  for (const row of rows) {
    const feed = row?.object || row?.feedObject || row;
    if (!feed || typeof feed !== "object" || !feed.id || !feed.objectDesc || feed.liveInfo || Number(feed.objectDesc.mediaType) !== 4) continue;
    const description = cleanSearchDescription(feed.objectDesc.description);
    if (!description || !matchesSearchDescription(description, keyword)) continue;
    feeds.push({ ...feed, objectDesc: { ...feed.objectDesc, description }, contact: feed.contact?.username ? feed.contact : row.contact || feed.contact });
  }
  return [...new Map(feeds.map(feed => [String(feed.id), feed])).values()];
}
export function sortFeedsByLikes(feeds, metrics) {
  const count = feed => {
    const n = metrics.get(String(feed.id))?.counts?.favCount;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  return [...feeds].sort((a, b) => {
    const left = count(a), right = count(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== right) return right - left;
    return (Number(b.createtime) || 0) - (Number(a.createtime) || 0);
  });
}
export function nextCursor(data, previous, search = false) {
  if (data.continueFlag === 0 || data.continueFlag === false) return "";
  const cursor = String((search ? data.lastBuff || data.lastBuffer : data.lastBuffer || data.lastBuff) || "");
  return cursor && cursor !== previous ? cursor : "";
}
export function taskBody(feeds, metrics = new Map()) {
  return { objects: feeds.map(feed => ({ platform: "wxchannels", content: metrics.get(String(feed.id)) ? {...feed, wxchannels_metrics: metrics.get(String(feed.id))} : feed, config: { skip: true, existing_action: "skip" }, auto_start: true })) };
}
export function safeImage(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
const lastQueryAt = { search: 0, detail: 0 };
export async function api(path, body, { signal, onWait } = {}) {
  signal?.throwIfAborted();
  const searchRequest = path.startsWith("/api/channels/contact/search") || path.startsWith("/api/channels/feed/search");
  const detailRequest = path.startsWith("/api/channels/contact/feed/") || path.startsWith("/api/channels/feed/profile") || path === "/api/channels/metrics/refresh";
  if (searchRequest || detailRequest) {
    const lane = searchRequest ? "search" : "detail";
    const interval = searchRequest ? 2000 : 5000;
    const wait = Math.max(0, lastQueryAt[lane] + interval - Date.now());
    lastQueryAt[lane] = Date.now() + wait;
    if (wait) onWait?.(Math.ceil(wait / 1000));
    if (wait) await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(waitTimer); reject(signal.reason); };
      const waitTimer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, wait);
      signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
    if (wait) onWait?.(0);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), body ? 120000 : 25000);
  try {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    if (!response.ok) throw new Error(`服务响应异常（${response.status}）`);
    const envelope = await response.json();
    if (envelope.code !== 0) throw new Error(envelope.msg || "请求失败");
    const result = envelope.data || {};
    if (result.errCode !== undefined) {
      if (result.errCode !== 0) throw new Error(result.errMsg || "微信接口调用失败");
      return result.data || {};
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === "AbortError" && path === "/api/channels/metrics/refresh") throw new Error("互动数据请求超时，可重试");
    if (error.name === "AbortError") throw new Error(body ? "提交超时，请先检查下载任务，再决定是否重试。" : "请求超时，请检查微信连接后重试。");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function mount(root, options = {}) {
  const doc = root.ownerDocument;
  const $ = id => root.querySelector(`#${id}`);
  let disposed = false;
  let busy = false, searchReady = false, feedsReady = false, statusBusy = false, openBusy = false, detailReady = false;
  let mode = "works", category = "video", author = null, keyword = "", authorCursor = "", feedCursor = "";
  let categoryChecksReady = false;
  let authors = [], feeds = [], selected = new Set(), outcomes = new Map();
  let timer;
  let feedLoaded = false, pagingFailed = false;
  const feedPages = new Set();
  const metrics = new Map();
  const create = (tag, text, cls) => { const el = doc.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const message = (text, error = false) => { if (disposed) return; $("message").textContent = text; $("message").className = error ? "error" : ""; };
  const articleSearch = mountArticleSearch(root, options);
  const articleSection = articleSearch.section;
  const categoryNav = root.querySelector(".content-categories");
  const videoCategory = create("button", "视频", "content-category");
  const articleCategory = create("button", "公众号文章", "content-category");
  videoCategory.type = "button"; articleCategory.type = "button";
  categoryNav.append(videoCategory, articleCategory);
  function switchCategory(next) {
    const articles = next === "articles";
    category = next;
    videoCategory.setAttribute("aria-pressed", String(!articles));
    articleCategory.setAttribute("aria-pressed", String(articles));
    root.dataset.category = next;
    root.closest(".channels-page")?.setAttribute("data-category", next);
    root.querySelector(".intro p:last-child").textContent = articles
      ? "通过电脑微信搜一搜查找公众号或文章；选择结果后可批量归档正文、图片和内嵌媒体。"
      : "按关键词查找不同作者的视频并按点赞排序，或按作者浏览；已下载内容请到账号页查看。";
    root.querySelector(".connection").setAttribute("aria-label", articles ? "微信搜一搜连接" : "视频号微信连接");
    $("check").title = articles ? "重新检查微信搜一搜连接" : "重新检查视频号微信连接";
    $("open-channels").hidden = articles;
    $("message").hidden = articles;
    root.querySelector(".workspace").hidden = articles;
    articleSection.hidden = !articles;
    if (categoryChecksReady) void check(true);
  }
  videoCategory.onclick = () => switchCategory("video");
  articleCategory.onclick = () => switchCategory("articles");
  switchCategory("video");
  const metricQueue = createMetricsQueue({
    canRun: () => !disposed && !busy && detailReady,
    request: (feed, signal) => api("/api/channels/metrics/refresh", { id: String(feed.id), nonce_id: feed.objectNonceId || "" }, { signal }),
    onChange(id, update) {
      const oldLikes = metrics.get(id)?.counts?.favCount;
      metrics.set(id, mergeLiveMetrics(metrics.get(id), update));
      const feed = feeds.find(item => String(item.id) === id);
      if (!feed || disposed) return;
      if (mode === "works" && oldLikes !== metrics.get(id)?.counts?.favCount) renderFeeds();
      else for (const row of $("feeds").querySelectorAll(".feed")) {
        if (row.dataset.feedId === id) fillCounters(row.querySelector(".feed-metrics"), feed);
      }
      updateMetricStatus();
      if (outcomes.get(id)?.done && ["done", "partial"].includes(update.auto_state)) void Promise.resolve(options.onTasksCreated?.()).catch(() => {});
    },
  });
  categoryChecksReady = true;
  function fillCounters(element, feed) {
    const m = metrics.get(String(feed.id));
    const labels = { queued: "等待自动获取", loading: "正在获取互动数据…", failed: "获取失败", partial: "部分数字未返回" };
    const note = [m?.auto_state === "failed" ? m.error || labels.failed : labels[m?.auto_state], metricsNote(m)].filter(Boolean).join(" · ");
    const detail = create("small", note, "metrics-note");
    detail.title = m?.error || note;
    element.replaceChildren(create("p", metricsText(m), "metrics"), detail);
    if (["failed", "partial"].includes(m?.auto_state)) {
      const retry = create("button", "重试", "metric-retry");
      retry.type = "button"; retry.title = m.error || "重新获取这条作品的互动数据"; retry.disabled = !detailReady;
      retry.onclick = () => metricQueue.add(feed, true);
      element.append(retry);
    }
  }
  function updateMetricStatus() {
    if (disposed) return;
    const values = feeds.map(feed => metrics.get(String(feed.id)));
    const pending = values.filter(m => ["queued", "loading"].includes(m?.auto_state)).length;
    const failed = values.filter(m => ["failed", "partial"].includes(m?.auto_state)).length;
    $("metrics-status").textContent = !feeds.length ? "" : pending
      ? `互动数据自动获取中 · 剩余 ${pending} 条${detailReady ? "" : " · 等待微信详情接口就绪"}${failed ? ` · ${failed} 条可重试` : ""}`
      : failed ? `互动数据已处理 · ${failed} 条未获取完整，可在对应作品重试` : "互动数据已自动获取";
  }
  const eligible = feed => String(feed.id || "") && Number(feed.objectDesc?.mediaType) === 4 && !outcomes.get(String(feed.id))?.done;
  function controls() {
    if (disposed) return;
    $("search-button").disabled = busy || !searchReady;
    $("keyword").disabled = busy;
    $("more-authors").disabled = busy || !searchReady;
    $("more-feeds").disabled = busy || !(mode === "works" ? searchReady : feedsReady) || (feedLoaded && !feedCursor);
    root.querySelectorAll(".metric-retry").forEach(el => { el.disabled = !detailReady; });
    $("download").disabled = busy || !(mode === "works" ? searchReady : feedsReady) || !selected.size;
    $("download").textContent = `下载所选（${selected.size}）`;
    const available = feeds.filter(eligible);
    $("select-all").disabled = busy || !available.length;
    $("select-all").checked = available.length > 0 && available.every(f => selected.has(String(f.id)));
    $("select-all").indeterminate = selected.size > 0 && !$("select-all").checked;
    root.querySelectorAll(".author").forEach(el => { el.disabled = busy || !feedsReady; });
    root.querySelectorAll(".feed input").forEach(el => { el.disabled = busy || el.dataset.eligible !== "true"; });
  }
  async function run(action) {
    if (busy || disposed) return;
    busy = true; controls(); message("正在处理…");
    try { await action(); } catch (error) { message(error.message, true); }
    finally { busy = false; controls(); if (!disposed) queueMicrotask(onFeedScroll);
      void metricQueue.kick(); }
  }
  function connection(kind, text, help) {
    $("status").textContent = text;
    $("status").dataset.state = kind;
    $("status").title = help;
    $("connection-help").textContent = help;
  }
  async function check(manual = false) {
    if (statusBusy || openBusy || disposed) return;
    statusBusy = true;
    $("check").disabled = true;
    $("check").textContent = "检查中…";
    if (manual) connection("checking", category === "articles" ? "正在检查微信搜一搜…" : "正在检查视频号…", category === "articles" ? "正在确认微信搜一搜文章桥接是否可用。" : "正在确认视频号连接及搜索、作品接口是否可用。");
    try {
      const state = await api("/api/channels/status");
      if (disposed) return;
      searchReady = !!state.available && !!state.search_ready;
      feedsReady = !!state.available && !!state.feeds_ready;
      detailReady = !!state.available && !!state.detail_ready;
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      if (category === "articles") {
        const articleState = await api("/api/mp/article/search/status");
        if (articleState.connected) connection("ready", "✓ 微信搜一搜已连接", "检查完成 " + time + " · 可以从工作台搜索公众号和文章；保持微信搜一搜页面打开。");
        else connection("waiting", "微信搜一搜未连接", articleState.message || "请在电脑微信打开或刷新搜一搜页面。");
      } else if (!state.available) {
        connection("waiting", "视频号未连接", "请在电脑微信打开或刷新视频号作者主页，再点击「检查」。");
      } else if (searchReady && feedsReady) {
        connection("ready", "✓ 视频号已连接", "检查完成 " + time + " · 可以搜索和下载视频；保持微信视频号窗口打开。");
      } else {
        connection("waiting", "视频号接口未就绪", "请等待微信页面加载完成，或重新打开作者主页后检查。");
      }
    } catch {
      if (disposed) return;
      searchReady = feedsReady = detailReady = false;
      connection("error", "视频号连接检查失败", "请确认 Host 仍在运行，并检查启动终端中的错误。");
    } finally {
      statusBusy = false;
      if (!disposed) { $("check").disabled = false; $("check").textContent = "检查"; controls(); updateMetricStatus(); void metricQueue.kick(); }
    }
  }
  async function openChannels() {
    if (openBusy || disposed) return;
    openBusy = true;
    $("open-channels").disabled = true;
    $("check").disabled = true;
    connection("checking", "正在打开视频号…", "正在让专用微信打开可连接的独立视频号主页。");
    try {
      await api("/api/channels/open", {});
      if (disposed) return;
      connection("checking", "视频号页面已打开", "正在等待视频号页面加载并连接工作台…");
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      if (!disposed) connection("error", "打开视频号失败", error.message || "请先在专用微信打开搜一搜，再重试。");
      return;
    } finally {
      openBusy = false;
      if (!disposed) {
        $("open-channels").disabled = false;
        $("check").disabled = false;
      }
    }
    await check(true);
  }
  function image(url, alt) {
    const placeholder = () => create("span", alt ? "暂无封面" : "作者", alt ? "cover-placeholder" : "avatar-placeholder");
    const src = safeImage(url); if (!src) return placeholder();
    const img = create("img"); img.alt = alt; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.src = src;
    img.addEventListener("error", () => img.replaceWith(placeholder()), { once: true }); return img;
  }
  function renderAuthors() {
    if (disposed) return;
    $("authors").hidden = mode !== "authors";
    $("authors").replaceChildren();
    if (mode === "authors" && !authors.length) $("authors").append(create("p", "没有找到作者，可以换个关键词重试。", "empty"));
    for (const item of authors) {
      const btn = create("button", "", "author"); btn.type = "button"; btn.setAttribute("aria-pressed", String(author?.username === item.username));
      const name = create("span", item.nickname || item.username); name.append(create("small", item.username));
      btn.append(image(item.headUrl, ""), name);
      btn.onclick = () => run(async () => {
        metricQueue.reset(); metrics.clear();
        author = item; feeds = []; selected.clear(); outcomes.clear(); feedCursor = ""; feedLoaded = false; pagingFailed = false; feedPages.clear();
        renderAuthors(); renderFeeds(); await loadFeeds();
      });
      $("authors").append(btn);
    }
    $("more-authors").hidden = mode !== "authors" || !authorCursor; controls();
  }
  function renderFeeds() {
    if (disposed) return;
    const scrollTop = $("feeds").scrollTop;
    $("feeds").replaceChildren();
    $("author-title").textContent = mode === "works" ? (keyword ? `“${keyword}”的作品` : "关键词作品") : author?.nickname || "视频列表";
    const knownLikes = feeds.filter(feed => {
      const n = metrics.get(String(feed.id))?.counts?.favCount;
      return Number.isSafeInteger(n) && n >= 0;
    }).length;
    $("count").textContent = mode === "works"
      ? keyword ? `已加载 ${feeds.length} 条匹配视频 · ${knownLikes} 条有点赞数 · ${!feedLoaded || feedCursor || knownLikes < feeds.length ? "当前已加载结果排行" : "本次可获取结果排行"}` : "输入关键词开始搜索"
      : author ? `线上作品 · 已加载 ${feeds.length} 条 · 可选视频 ${feeds.filter(eligible).length} 条` : "尚未选择作者";
    if (!feeds.length) $("feeds").append(create("p", mode === "works" ? keyword ? "微信当前搜索结果没有返回可用的视频作品。可换个关键词重试。" : "搜索后，在这里浏览按点赞排序的作品。" : author ? "暂无作品；可点击重新加载重试。" : "选择作者后查看视频。", "empty"));
    for (const feed of mode === "works" ? sortFeedsByLikes(feeds, metrics) : feeds) {
      const id = String(feed.id), desc = feed.objectDesc || {}, media = desc.media?.[0] || {};
      const row = create("article", "", "feed"), box = create("input"); box.type = "checkbox"; box.checked = selected.has(id); box.dataset.eligible = String(!!eligible(feed)); box.setAttribute("aria-label", `选择 ${desc.description || id}`);
      box.onchange = () => { if (box.checked && selected.size >= 100) { box.checked = false; message("每批最多选择 100 条视频。", true); return; } box.checked ? selected.add(id) : selected.delete(id); controls(); };
      const content = create("div", "", "feed-info");
      const title = create("p", desc.description || "未命名作品", "feed-title"); title.title = desc.description || ""; content.append(title);
      const date = Number(feed.createtime) > 0 ? new Date(Number(feed.createtime) * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "时间未知";
      content.append(create("small", `${mode === "works" ? (feed.contact?.nickname || feed.contact?.username || "作者未知") + " · " : ""}${date} · ${Number(desc.mediaType) === 4 ? "视频" : "非普通视频，暂不选择"}`));
      const counters = create("div", "", "feed-metrics");
      row.dataset.feedId = id;
      fillCounters(counters, feed);
      const state = create("div", outcomes.get(id)?.text || (metrics.get(id)?.local_downloaded === true ? "本地已有" : metrics.get(id)?.local_downloaded === false ? "未下载" : "本地状态待确认"), "feed-state");
      row.append(box, image(media.coverUrl || media.thumbUrl, "作品封面"), content, counters, state); $("feeds").append(row);
    }
    $("feeds").scrollTop = scrollTop;
    updateMetricStatus();
    $("more-feeds").hidden = mode === "works" ? !keyword : !author;
    $("more-feeds").textContent = pagingFailed ? "加载失败，点击重试" : feedCursor ? "加载更多作品（也可向下滚动）" : feedLoaded ? "已加载全部可获取作品" : "重新加载作品";
    $("more-feeds").disabled = feedLoaded && !feedCursor;
    controls();
  }
  async function loadAuthors(more) {
    const previous = more ? authorCursor : "";
    const data = await api("/api/channels/contact/search?" + new URLSearchParams({ keyword, next_marker: previous }));
    authors = [...new Map([...(more ? authors : []), ...contacts(data)].map(x => [x.username, x])).values()];
    authorCursor = nextCursor(data, previous, true); renderAuthors(); message(`找到 ${authors.length} 位作者，请选择目标作者。`);
  }
  async function loadFeeds() {
    if (!author || (feedLoaded && !feedCursor)) return;
    const previous = feedCursor;
    pagingFailed = false;
    $("more-feeds").textContent = "正在加载线上作品…";
    try {
      const data = await api("/api/channels/contact/feed/list?" + new URLSearchParams({ username: author.username, next_marker: previous }));
      if (disposed) return;
      const rows = Array.isArray(data.object) ? data.object.filter(x => x.id) : [];
      // Commit a page only after the online request succeeds. Retry keeps its cursor.
      feeds = [...new Map([...feeds, ...rows].map(x => [String(x.id), x])).values()];
      feedPages.add(previous);
      const next = nextCursor(data, previous);
      feedCursor = feedPages.has(next) ? "" : next;
      feedLoaded = true;
      const freshList = new Map(rows.map(feed => [String(feed.id), listMetrics(feed)]));
      for (const [id, fresh] of freshList) metrics.set(id, mergeLiveMetrics(metrics.get(id), fresh));
      renderFeeds();
      let metricError = false;
      for (let offset = 0; offset < rows.length && !disposed; offset += 100) {
        const ids = rows.slice(offset, offset + 100).map(feed => String(feed.id));
        try {
          const saved = await api("/api/channels/metrics?" + new URLSearchParams({ids: ids.join(",")}));
          for (const [id, value] of Object.entries(saved || {})) {
            const current = metrics.get(id) || {};
            metrics.set(id, {...mergeLiveMetrics(value, current), local_downloaded: value.local_downloaded});
          }
        } catch { metricError = true; }
      }
      for (const feed of rows) {
        if (freshList.get(String(feed.id)).status !== "ok") metricQueue.add(feed);
        else metrics.set(String(feed.id), {...metrics.get(String(feed.id)), auto_state: "done"});
      }
      renderFeeds();
      message(metricError ? "作品已加载，本地状态读取失败；互动数据会自动获取。" : feedCursor ? "向下滚动继续加载线上作品。" : "已加载全部可获取作品，以微信接口返回范围为准。", metricError);
    } catch (error) {
      pagingFailed = true; renderFeeds(); throw error;
    }
  }
  async function loadKeywordFeeds() {
    if (!keyword || (feedLoaded && !feedCursor)) return;
    const previous = feedCursor;
    pagingFailed = false;
    $("more-feeds").textContent = "正在搜索作品…";
    try {
      message("正在向微信搜索作品…");
      const data = await api("/api/channels/feed/search?" + new URLSearchParams({ keyword, next_marker: previous }), undefined, { onWait: seconds => message(seconds ? `等待微信请求间隔，约 ${seconds} 秒…` : "正在向微信搜索作品…") });
      if (disposed) return;
      const rows = searchFeeds(data, keyword);
      feeds = [...new Map([...feeds, ...rows].map(feed => [String(feed.id), feed])).values()];
      feedPages.add(previous);
      const next = nextCursor(data, previous, true);
      feedCursor = feedPages.has(next) ? "" : next;
      feedLoaded = true;
      const freshList = new Map(rows.map(feed => [String(feed.id), listMetrics(feed)]));
      for (const [id, fresh] of freshList) metrics.set(id, mergeLiveMetrics(metrics.get(id), fresh));
      renderFeeds();
      let metricError = false;
      for (let offset = 0; offset < rows.length && !disposed; offset += 100) {
        const ids = rows.slice(offset, offset + 100).map(feed => String(feed.id));
        try {
          const saved = await api("/api/channels/metrics?" + new URLSearchParams({ ids: ids.join(",") }));
          for (const [id, value] of Object.entries(saved || {})) {
            const current = metrics.get(id) || {};
            metrics.set(id, { ...mergeLiveMetrics(value, current), local_downloaded: value.local_downloaded });
          }
        } catch { metricError = true; }
      }
      for (const feed of rows) {
        if (!Number.isSafeInteger(metrics.get(String(feed.id))?.counts?.favCount)) metricQueue.add(feed);
        else metrics.set(String(feed.id), { ...metrics.get(String(feed.id)), auto_state: "done" });
      }
      renderFeeds();
      message(!feeds.length ? (data.infoList?.length ? `当前微信搜索只返回作者，未返回视频；${feedCursor ? "可继续翻页或换个关键词。" : "这个关键词暂无法生成作品排行。"}` : `当前搜索没有返回视频；${feedCursor ? "可继续翻页或换个关键词。" : "请换个关键词。"}`) : metricError ? "作品已加载，本地指标读取失败；正在尝试获取点赞数。" : feedCursor ? "当前按已加载作品的点赞数排序；向下滚动可加载更多。" : "已按本次微信返回的作品排序。", metricError);
    } catch (error) {
      pagingFailed = true; renderFeeds(); throw error;
    }
  }
  const loadCurrentFeeds = () => mode === "works" ? loadKeywordFeeds() : loadFeeds();
  function onFeedScroll() {
    const list = $("feeds");
    if (!(mode === "works" ? keyword : author) || !feedLoaded || !feedCursor || busy || !(mode === "works" ? searchReady : feedsReady) || pagingFailed || disposed) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) run(loadCurrentFeeds);
  }
  $("feeds").addEventListener("scroll", onFeedScroll, { passive: true });

  function resetSearch() {
    metricQueue.reset(); metrics.clear(); keyword = ""; authorCursor = ""; authors = []; author = null; feeds = []; selected.clear(); outcomes.clear(); feedCursor = ""; feedLoaded = false; pagingFailed = false; feedPages.clear();
    renderAuthors(); renderFeeds(); message("");
  }
  function switchMode(next) {
    if (busy || mode === next) return;
    mode = next;
    $("mode-works").setAttribute("aria-pressed", String(mode === "works"));
    $("mode-authors").setAttribute("aria-pressed", String(mode === "authors"));
    $("search-label").textContent = mode === "works" ? "作品关键词或话题" : "作者名称或账号 ID";
    $("keyword").placeholder = mode === "works" ? "例如：人工智能" : "输入视频号名称";
    $("search-hint").textContent = mode === "works" ? "只展示作品文案或话题包含关键词的普通视频；点赞排行随加载更新。" : "选择一位作者浏览其线上作品。";
    $("keyword").value = "";
    resetSearch();
  }
  $("mode-works").onclick = () => switchMode("works");
  $("mode-authors").onclick = () => switchMode("authors");
  $("search").onsubmit = event => { event.preventDefault(); if (!searchReady) return; const value = $("keyword").value.trim(); if (!value) return; run(async () => { resetSearch(); keyword = value; renderFeeds(); await (mode === "works" ? loadKeywordFeeds() : loadAuthors(false)); }); };
  $("more-authors").onclick = () => run(() => loadAuthors(true));
  $("more-feeds").onclick = () => run(loadCurrentFeeds);
  $("check").onclick = () => check(true);
  $("open-channels").onclick = () => openChannels();
  $("select-all").onchange = event => { selected = event.target.checked ? new Set(feeds.filter(eligible).slice(0, 100).map(f => String(f.id))) : new Set(); renderFeeds(); };
  $("download").onclick = () => run(async () => {
    const chosen = feeds.filter(f => selected.has(String(f.id)) && eligible(f));
    if (!chosen.length) return;
    options.onDownloadStarted?.();
    message("正在准备作品并创建下载任务，进度在下方实时更新…");
    const ready = [], unresolved = [];
    for (const feed of chosen) {
      if (mode !== "works" || (feed.contact?.username && feed.objectDesc?.media?.some(item => item.url))) { ready.push(feed); continue; }
      try {
        const profile = await api("/api/channels/feed/profile?" + new URLSearchParams({ oid: String(feed.id), nid: feed.objectNonceId || "" }));
        const full = profile.object ? { ...profile.object, contact: profile.object.contact?.username ? profile.object.contact : feed.contact } : null;
        if (String(full?.id) !== String(feed.id) || !full?.contact?.username || !full?.objectDesc?.media?.some(item => item.url)) throw new Error("微信详情未返回完整下载信息");
        ready.push(full);
      } catch (error) { unresolved.push({ feed, error }); }
    }
    if (!ready.length) {
      for (const { feed, error } of unresolved) outcomes.set(String(feed.id), { done: false, text: error.message });
      renderFeeds(); message(`${unresolved.length} 条作品缺少下载信息；请保持微信连接后重试。`, true); return;
    }
    const data = await api("/api/v1/download_task/create", taskBody(ready, metrics));
    if (disposed) return;
    let added = 0, skipped = 0, failed = unresolved.length;
    for (const { feed, error } of unresolved) outcomes.set(String(feed.id), { done: false, text: error.message });
    ready.forEach((feed, index) => {
      const item = data.tasks?.[index], id = String(feed.id);
      if (item?.code === 0) {
        const exists = !!item.data?.skipped;
        exists ? skipped++ : added++; selected.delete(id);
        outcomes.set(id, { done: true, text: exists ? `已有任务 #${item.data?.id || ""}，进度见下方` : `已加入任务 #${item.data?.id || ""}，进度见下方` });
      } else { failed++; outcomes.set(id, { done: false, text: item?.msg || "任务结果未确认，请查看下载任务后重试" }); }
    });
    renderFeeds(); message(`新增 ${added} 条，已有任务跳过 ${skipped} 条，失败 ${failed} 条。进度与操作见下方下载管理。`, failed > 0);
    try { await options.onTasksCreated?.(data); }
    catch { message("任务已提交，但进度刷新失败，请在下方重试刷新。", true); }
  });
  check(); timer = setInterval(check, 5000);
  return () => { disposed = true; articleSearch.dispose(); metricQueue.dispose(); clearInterval(timer); $("feeds").removeEventListener("scroll", onFeedScroll); };
}
