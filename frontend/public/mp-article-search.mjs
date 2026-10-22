const httpURL = value => {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.protocol = "https:";
    return url.href;
  } catch { return ""; }
};

const articleURL = value => {
  const url = httpURL(String(value || "").replace(/&amp;/gi, "&"));
  if (!url) return "";
  try { return new URL(url).hostname === "mp.weixin.qq.com" ? url : ""; }
  catch { return ""; }
};

export const officialAccountFeedKeyword = "EMPTY_QUERY_PLACEHOLDER";

const plain = value => String(value || "")
  .replace(/<[^>]*>/g, "")
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, match => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&#39;": "'" })[match.toLowerCase()] || match)
  .replace(/\s+/g, " ").trim();

function firstText(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    if (typeof row[key] === "string" && plain(row[key])) return plain(row[key]);
  }
  return "";
}

function deepText(row, keys, depth = 0, seen = new WeakSet()) {
  if (!row || typeof row !== "object" || depth > 5 || seen.has(row)) return "";
  seen.add(row);
  const direct = firstText(row, keys);
  if (direct) return direct;
  for (const value of Object.values(row)) {
    const found = deepText(value, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function deepURL(row, keys, depth = 0, seen = new WeakSet()) {
  if (!row || typeof row !== "object" || depth > 6 || seen.has(row)) return "";
  seen.add(row);
  for (const key of keys) {
    const found = httpURL(row[key]);
    if (found) return found;
  }
  for (const value of Object.values(row)) {
    const found = deepURL(value, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function embeddedJSON(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try { return JSON.parse(value); }
  catch { return {}; }
}

function articleBizuin(value) {
  try {
    const encoded = new URL(value).searchParams.get("__biz");
    if (!encoded || typeof globalThis.atob !== "function") return "";
    return plain(globalThis.atob(encoded));
  } catch { return ""; }
}

function unixSeconds(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    let seconds = numeric;
    if (seconds > 1000000000000000) seconds /= 1000000;
    else if (seconds > 1000000000000) seconds /= 1000;
    return seconds >= 946684800 ? Math.floor(seconds) : 0;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

function articlePublishedAt(node, parent) {
  const keys = ["publishTime", "publish_time", "pubTime", "pub_time", "createTime", "create_time", "datetime", "timestamp", "date"];
  for (const row of [node, parent]) {
    if (!row || typeof row !== "object") continue;
    for (const key of keys) {
      const value = unixSeconds(row[key]);
      if (value) return value;
    }
  }
  return 0;
}

function searchField(payload, keys) {
  for (const row of [payload, payload?.data, payload?.result]) {
    if (!row || typeof row !== "object") continue;
    for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

export function nativeSearchPageState(payload, previousOffset = 0) {
  const continueValue = searchField(payload, ["continueFlag", "ContinueFlag", "continue_flag", "hasMore", "has_more"]);
  const hasMore = continueValue === true || Number(continueValue) > 0 || String(continueValue).toLowerCase() === "true";
  const rawOffset = Number(searchField(payload, ["offset", "Offset", "nextOffset", "next_offset"]));
  const nextOffset = Number.isSafeInteger(rawOffset) && rawOffset > previousOffset ? rawOffset : previousOffset + 20;
  const cookies = searchField(payload, ["cookies", "Cookies"]);
  const searchID = searchField(payload, ["searchID", "searchId", "SearchID", "SearchId"]);
  const diffRequestID = searchField(payload, ["_sphDiffRequestId"]);
  return {
    hasMore,
    nextOffset,
    cookies: typeof cookies === "string" ? cookies : "",
    searchID: typeof searchID === "string" ? searchID : "",
    diffRequestID: typeof diffRequestID === "string" ? diffRequestID : "",
  };
}

export function nativeSearchTotalCount(payload) {
  let total = 0;
  const seen = new WeakSet();
  function visit(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 10 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) {
      for (const key of ["totalCount", "total_count"]) {
        const value = Number(node[key]);
        if (Number.isSafeInteger(value) && value > total) total = value;
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  }
  visit(payload);
  return total;
}

export function sortArticlesByTime(items) {
  return items.map((article, index) => ({ article, index })).sort((left, right) => {
    const a = Number(left.article.publishedAt) || 0;
    const b = Number(right.article.publishedAt) || 0;
    if (a && b && a !== b) return b - a;
    if (a !== b) return b ? 1 : -1;
    return left.index - right.index;
  }).map(item => item.article);
}

export function nativeArticles(payload) {
  const found = new Map();
  const seen = new WeakSet();
  let visited = 0;
  function visit(node, parent = {}, depth = 0) {
    if (!node || typeof node !== "object" || depth > 10 || visited++ > 20000 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) visit(item, parent, depth + 1); return; }
    const title = firstText(node, ["title", "Title", "articleTitle", "article_title", "displayTitle", "display_title"])
      || firstText(parent, ["title", "Title", "articleTitle", "article_title"]);
    const author = firstText(node, ["bizName", "biz_name", "accountName", "account_name", "sourceName", "source_name", "nickName", "nickname", "author"])
      || firstText(node.source || {}, ["title", "name"])
      || firstText(parent, ["bizName", "biz_name", "accountName", "account_name", "sourceName", "source_name"]);
    const excerpt = firstText(node, ["excerpt", "summary", "digest", "description", "desc", "snippet", "content"]);
    for (const key of ["url", "Url", "link", "linkUrl", "link_url", "articleUrl", "article_url", "jumpUrl", "jump_url", "webUrl", "web_url", "doc_url"]) {
      const url = articleURL(node[key]);
      if (url && title && !found.has(url)) {
        const publishedAt = articlePublishedAt(node, parent);
        found.set(url, { title, author, excerpt, url, ...(publishedAt ? { publishedAt } : {}) });
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value, node, depth + 1);
  }
  visit(payload);
  return [...found.values()];
}

export function nativeAccounts(payload) {
  const found = new Map();
  const seen = new WeakSet();
  let visited = 0;
  function visit(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 10 || visited++ > 20000 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const jump = node.jumpInfo && typeof node.jumpInfo === "object" ? node.jumpInfo : null;
    if (jump) {
      const username = firstText(jump, ["userName", "username"]);
      const nickname = firstText(jump, ["nickName", "nickname"]) || firstText(node, ["title", "name"]);
      if (username && nickname && !found.has(username)) {
        const brandInfo = embeddedJSON(jump.brandInfo);
        const externalInfo = embeddedJSON(jump.externalInfo);
        found.set(username, {
          username,
          nickname,
          alias: firstText(jump, ["aliasName", "alias"]),
          bizuin: firstText(jump, ["bizuin", "bizUin"]),
          avatar: deepURL(jump, ["headHDImgUrl", "headImgUrl", "headImageUrl", "avatarUrl", "avatar", "iconUrl"]),
          description: firstText(jump, ["signature", "description", "desc"]) || firstText(node, ["desc", "description"]),
          verification: firstText(node.source || {}, ["title", "name"])
            || deepText(externalInfo, ["Description", "verifyName", "verifyInfo", "authInfo", "verifiedName", "organization"]),
          profileURL: articleURL(deepURL(brandInfo, ["url", "profileUrl", "profileURL"])),
        });
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value, depth + 1);
  }
  visit(payload);
  return [...found.values()];
}

export function articlesForAccount(payload, account) {
  const wanted = plain(account?.nickname).toLocaleLowerCase();
  const wantedBizuin = plain(account?.bizuin);
  if (!wanted) return [];
  return nativeArticles(payload).filter(article => {
    const bizuin = articleBizuin(article.url);
    if (wantedBizuin && bizuin) return bizuin === wantedBizuin;
    const author = plain(article.author).toLocaleLowerCase();
    return author === wanted;
  });
}

export function accountHistoryBiz(account) {
  try {
    const fromProfile = new URL(String(account?.profileURL || "")).searchParams.get("__biz");
    if (fromProfile) return fromProfile.trim();
  } catch {}
  const numeric = plain(account?.bizuin);
  if (!numeric || typeof globalThis.btoa !== "function") return "";
  try { return globalThis.btoa(numeric); }
  catch { return ""; }
}

function officialAccountHistoryList(payload) {
  const direct = payload?.list;
  if (Array.isArray(direct)) return direct;
  const embedded = embeddedJSON(payload?.general_msg_list);
  return Array.isArray(embedded?.list) ? embedded.list : [];
}

export function officialAccountHistoryArticles(payload, account = {}) {
  const found = new Map();
  for (const message of officialAccountHistoryList(payload)) {
    const publishedAt = unixSeconds(message?.comm_msg_info?.datetime);
    const main = message?.app_msg_ext_info;
    if (!main || typeof main !== "object") continue;
    const rows = [main, ...(Array.isArray(main.multi_app_msg_item_list) ? main.multi_app_msg_item_list : [])];
    for (const row of rows) {
      const url = articleURL(row?.content_url);
      const title = plain(row?.title);
      if (!url || !title || found.has(url)) continue;
      found.set(url, {
        title,
        author: plain(row?.author) || plain(account?.nickname),
        excerpt: plain(row?.digest || row?.content),
        url,
        ...(publishedAt ? { publishedAt } : {}),
      });
    }
  }
  return [...found.values()];
}

export function officialAccountHistoryPageState(payload, previousOffset = 0) {
  const continueValue = payload?.can_msg_continue ?? payload?.has_more ?? 0;
  const hasMore = continueValue === true || Number(continueValue) > 0 || String(continueValue).toLowerCase() === "true";
  const rawOffset = Number(payload?.next_offset);
  return {
    hasMore,
    nextOffset: Number.isSafeInteger(rawOffset) && rawOffset > previousOffset ? rawOffset : previousOffset + 10,
  };
}

export function articleTaskBody(fetchResult) {
  return {
    objects: [{
      platform: "wxmp",
      content: fetchResult,
      build_from_fetch: true,
      config: { skip: true, existing_action: "skip" },
      auto_start: true,
    }],
  };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(path, body, signal) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) throw new Error(`服务响应异常（${response.status}）`);
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(envelope.msg || "请求失败");
  return envelope.data || {};
}

async function fetchArticle(url, signal) {
  const created = await request("/api/scraper/fetch", { url }, signal);
  const id = String(created.id || "").trim();
  if (!id) throw new Error("文章解析任务没有返回编号");
  const deadline = Date.now() + 120000;
  let job = created;
  while (!signal.aborted && !["completed", "failed", "interrupted"].includes(job.status)) {
    if (Date.now() >= deadline) throw new Error("文章解析超时");
    await delay(800);
    job = await request(`/api/scraper/job?id=${encodeURIComponent(id)}`, null, signal);
  }
  if (job.status !== "completed") throw new Error(job.error || "文章解析失败");
  if (!job.output?.result) throw new Error("文章解析完成，但没有返回正文");
  return job.output.result;
}

async function downloadArticle(article, signal) {
  const content = await fetchArticle(article.url, signal);
  const created = await request("/api/v1/download_task/create", articleTaskBody(content), signal);
  const item = created.tasks?.[0];
  if (item?.code !== 0) throw new Error(item?.msg || "下载任务创建失败");
  return { id: item.data?.id, skipped: !!item.data?.skipped };
}

export function articleDownloadState(payload, url) {
  const value = payload?.statuses?.[url];
  return ["downloaded", "not_downloaded", "unknown"].includes(value) ? value : "unknown";
}

export function mountArticleSearch(root, options = {}) {
  const doc = root.ownerDocument;
  const section = doc.createElement("section");
  section.className = "mp-search panel";
  section.hidden = true;
  section.innerHTML = '<h2>搜索公众号内容</h2><div class="search-modes mp-search-modes" role="group" aria-label="公众号搜索方式"><button class="mp-mode-articles" type="button" aria-pressed="true">搜文章</button><button class="mp-mode-accounts" type="button" aria-pressed="false">查公众号</button></div><form class="mp-search-form"><label for="mp-keyword">文章标题或内容关键词</label><div class="search-row"><input id="mp-keyword" required maxlength="100" autocomplete="off" placeholder="例如：人工智能"><button type="submit">搜索微信文章</button></div></form><p class="mp-search-note">工作台会把关键词发送到电脑微信的搜一搜文章接口；保持微信搜一搜页面打开即可。</p><div class="mp-account-context" hidden><button class="mp-back-accounts" type="button">返回公众号结果</button><span></span></div><div class="mp-article-toolbar"><label><input class="mp-select-all" type="checkbox" disabled> 全选已加载文章</label><span class="mp-selection-count">已选择 0 篇 · 每批最多 100 篇</span><button class="mp-download" type="button" disabled>下载所选（0）</button></div><p class="mp-search-status" role="status" aria-live="polite">输入关键词开始搜索。</p><div class="mp-search-results"></div><button class="mp-more-articles" type="button" hidden>加载更多文章</button><button class="mp-more-accounts" type="button" hidden>更多公众号</button>';
  root.querySelector(".workspace").after(section);
  const form = section.querySelector("form");
  const label = form.querySelector("label");
  const input = form.querySelector("input");
  const button = form.querySelector("button");
  const articleMode = section.querySelector(".mp-mode-articles");
  const accountMode = section.querySelector(".mp-mode-accounts");
  const note = section.querySelector(".mp-search-note");
  const toolbar = section.querySelector(".mp-article-toolbar");
  const accountContext = section.querySelector(".mp-account-context");
  const backAccounts = section.querySelector(".mp-back-accounts");
  const accountContextName = accountContext.querySelector("span");
  const moreArticles = section.querySelector(".mp-more-articles");
  const moreAccounts = section.querySelector(".mp-more-accounts");
  const selectAll = section.querySelector(".mp-select-all");
  const selectionCount = section.querySelector(".mp-selection-count");
  const download = section.querySelector(".mp-download");
  const status = section.querySelector(".mp-search-status");
  const results = section.querySelector(".mp-search-results");
  let sequence = 0;
  let mode = "articles";
  let view = "articles";
  let articles = [];
  let accounts = [];
  let accountQuery = "";
  let accountOffset = 0;
  let accountCookies = "";
  let accountSearchID = "";
  let accountDiffRequestID = "";
  let accountHasMore = false;
  let selectedAccount = null;
  let articleOffset = 0;
  let articleCookies = "";
  let articleSearchID = "";
  let articleDiffRequestID = "";
  let articleHasMore = false;
  let articleTotalCount = 0;
  let articleLoaded = false;
  let articlePagingFailed = false;
  let articlePages = new Set();
  let selected = new Set();
  let outcomes = new Map();
  let downloadStates = new Map();
  let searching = false;
  let downloading = false;
  const controller = new AbortController();

  function articleView() { return view === "articles"; }

  function isDownloadable(article) {
    return downloadStates.get(article.url) === "not_downloaded" && !outcomes.get(article.url)?.done;
  }

  async function refreshDownloadStates(items) {
    const urls = [...new Set(items.map(article => article.url).filter(Boolean))].slice(0, 100);
    if (!urls.length) return true;
    try {
      const data = await request("/api/mp/article/download-status", { urls }, controller.signal);
      for (const url of urls) downloadStates.set(url, articleDownloadState(data, url));
      return true;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      for (const url of urls) if (!downloadStates.has(url)) downloadStates.set(url, "unknown");
      return false;
    }
  }

  function updateControls() {
    const allAvailable = articles.filter(isDownloadable);
    const available = allAvailable.slice(0, 100);
    const selectedCount = available.filter(article => selected.has(article.url)).length;
    const downloadedCount = articles.filter(article => downloadStates.get(article.url) === "downloaded").length;
    toolbar.hidden = !articleView();
    accountContext.hidden = !(mode === "accounts" && articleView() && selectedAccount);
    moreAccounts.hidden = !(mode === "accounts" && view === "accounts" && accountHasMore);
    moreAccounts.disabled = searching || downloading;
    moreArticles.hidden = !(mode === "accounts" && articleView() && selectedAccount);
    moreArticles.disabled = searching || downloading || (articleLoaded && !articleHasMore && !articlePagingFailed);
    moreArticles.textContent = articlePagingFailed
      ? "加载失败，点击重试"
      : searching && selectedAccount && articleView()
        ? "正在加载文章…"
        : articleHasMore
          ? `加载更多该公众号文章${articleTotalCount ? `（${articles.length}/${articleTotalCount}）` : "（也可向下滚动）"}`
          : articleLoaded ? "已加载全部可获取文章" : "重新加载文章";
    selectAll.disabled = downloading || !available.length;
    selectAll.checked = !!available.length && available.every(article => selected.has(article.url));
    selectAll.indeterminate = selectedCount > 0 && !selectAll.checked;
    download.disabled = downloading || selectedCount === 0;
    download.textContent = downloading ? `正在下载（${selectedCount}）` : `下载所选（${selectedCount}）`;
    selectionCount.textContent = `已加载 ${articles.length} 篇：已下载 ${downloadedCount} 篇 · 可选未下载 ${allAvailable.length} 篇 · 已选择 ${selectedCount} 篇 · 每批最多 100 篇`;
    input.disabled = downloading || searching;
    button.disabled = downloading || searching;
    articleMode.disabled = downloading || searching;
    accountMode.disabled = downloading || searching;
    backAccounts.disabled = downloading || searching;
  }

  function renderArticles() {
    results.replaceChildren();
    for (const article of articles) {
      const item = doc.createElement("article");
      item.className = "mp-article";
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(article.url);
      const downloadState = downloadStates.get(article.url) || "unknown";
      checkbox.disabled = downloading || !isDownloadable(article);
      checkbox.setAttribute("aria-label", `选择 ${article.title}`);
      checkbox.addEventListener("change", () => {
        checkbox.checked ? selected.add(article.url) : selected.delete(article.url);
        updateControls();
      });
      const info = doc.createElement("div");
      info.className = "mp-article-info";
      const link = doc.createElement("a");
      link.href = article.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = article.title;
      info.append(link);
      const meta = [article.author, article.publishedAt ? new Date(article.publishedAt * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""].filter(Boolean).join(" · ");
      if (meta) { const author = doc.createElement("small"); author.textContent = meta; info.append(author); }
      if (article.excerpt) { const excerpt = doc.createElement("p"); excerpt.textContent = article.excerpt; info.append(excerpt); }
      const outcome = outcomes.get(article.url);
      if (outcome) {
        const result = doc.createElement("span");
        result.className = outcome.error ? "mp-article-result error" : "mp-article-result";
        result.textContent = outcome.text;
        info.append(result);
      } else {
        const result = doc.createElement("span");
        result.className = `mp-article-result ${downloadState === "downloaded" ? "downloaded" : downloadState === "not_downloaded" ? "available" : "unknown"}`;
        result.textContent = downloadState === "downloaded"
          ? "已下载 · 不可重复下载"
          : downloadState === "not_downloaded" ? "未下载" : "本地状态待确认 · 暂不可选";
        info.append(result);
      }
      item.append(checkbox, info);
      results.append(item);
    }
    updateControls();
  }

  async function loadAccountArticles(append = true) {
    if (!selectedAccount || searching || downloading || (append && articleLoaded && !articleHasMore && !articlePagingFailed)) return;
    const current = ++sequence;
    searching = true;
    const previousOffset = append ? articleOffset : 0;
    articlePagingFailed = false;
    status.textContent = append
      ? `正在加载“${selectedAccount.nickname}”更早的公众号文章…`
      : `正在查找“${selectedAccount.nickname}”发布的公众号文章…`;
    updateControls();
    try {
      let incoming;
      let page;
      const pageRequest = {
        keyword: officialAccountFeedKeyword,
        username: selectedAccount.username,
        offset: previousOffset,
        cookies: articleCookies,
        search_id: articleSearchID,
        diff_request_id: articleDiffRequestID,
      };
      // Native search cookies grow on every page and exceed a safe query-string
      // length after roughly 250 results. Keep the cursor in the request body so
      // the timeline can continue without an artificial 8 KiB cutoff.
      const data = await request("/api/mp/account/articles", pageRequest, controller.signal);
      incoming = articlesForAccount(data, selectedAccount);
      page = nativeSearchPageState(data, previousOffset);
      articleCookies = page.cookies;
      articleSearchID = page.searchID;
      articleDiffRequestID = page.diffRequestID;
      if (current !== sequence) return;
      articles = sortArticlesByTime([...new Map([...articles, ...incoming].map(article => [article.url, article])).values()]);
      const statusReady = await refreshDownloadStates(incoming);
      if (current !== sequence) return;
      articlePages.add(previousOffset);
      articleOffset = page.nextOffset;
      articleTotalCount = Math.max(articleTotalCount, nativeSearchTotalCount(data));
      articleHasMore = page.hasMore && !articlePages.has(page.nextOffset) && articleOffset <= 1000;
      articleLoaded = true;
      status.textContent = (articles.length
        ? `已在“${selectedAccount.nickname}”精确账号范围加载 ${articles.length}${articleTotalCount ? ` / 微信报告总数 ${articleTotalCount}` : ""} 篇文章 · 微信最新发布顺序${articleHasMore ? " · 可继续加载" : " · 已到微信可获取范围末尾"}`
        : articleHasMore
          ? `当前页没有识别到“${selectedAccount.nickname}”的文章，可以继续加载下一页。`
          : `微信精确账号检索已返回，但没有识别到“${selectedAccount.nickname}”的文章。`) + (statusReady ? "" : " · 本地下载状态核对失败，当前文章已暂停选择。");
      renderArticles();
    } catch (error) {
      if (current === sequence && error.name !== "AbortError") {
        articlePagingFailed = true;
        status.textContent = `加载公众号文章失败：${error.message || String(error)}`;
      }
    } finally {
      if (current === sequence) { searching = false; updateControls(); }
    }
  }

  async function chooseAccount(account) {
    if (searching || downloading) return;
    selectedAccount = account;
    view = "articles";
    accountContextName.textContent = `正在查看：${account.nickname}`;
    articles = [];
    selected.clear();
    outcomes.clear();
    downloadStates.clear();
    articleOffset = 0;
    articleCookies = "";
    articleSearchID = "";
    articleDiffRequestID = "";
    articleHasMore = false;
    articleTotalCount = 0;
    articleLoaded = false;
    articlePagingFailed = false;
    articlePages = new Set();
    renderArticles();
    await loadAccountArticles(false);
  }

  function renderAccounts() {
    results.replaceChildren();
    for (const account of accounts) {
      const item = doc.createElement("article");
      item.className = "mp-account";
      const avatar = account.avatar ? doc.createElement("img") : doc.createElement("span");
      if (account.avatar) { avatar.src = account.avatar; avatar.alt = ""; avatar.loading = "lazy"; }
      else { avatar.className = "mp-account-avatar-placeholder"; avatar.textContent = "公众号"; }
      const info = doc.createElement("div");
      info.className = "mp-account-info";
      const name = doc.createElement("strong");
      name.textContent = account.nickname;
      info.append(name);
      const identifiers = [account.alias ? `微信号 ${account.alias}` : "", account.verification].filter(Boolean).join(" · ");
      if (identifiers) { const meta = doc.createElement("small"); meta.textContent = identifiers; info.append(meta); }
      if (account.description) { const description = doc.createElement("p"); description.textContent = account.description; info.append(description); }
      const actions = doc.createElement("div");
      actions.className = "mp-account-actions";
      const choose = doc.createElement("button");
      choose.type = "button";
      choose.textContent = "查看文章";
      choose.addEventListener("click", () => void chooseAccount(account));
      actions.append(choose);
      item.append(avatar, info, actions);
      results.append(item);
    }
    updateControls();
  }

  function setMode(next) {
    if (downloading || searching || next === mode) return;
    sequence++;
    mode = next;
    view = next;
    selectedAccount = null;
    articles = [];
    accounts = [];
    selected.clear();
    outcomes.clear();
    downloadStates.clear();
    accountOffset = 0;
    accountCookies = "";
    accountSearchID = "";
    accountDiffRequestID = "";
    accountHasMore = false;
    articleOffset = 0;
    articleCookies = "";
    articleSearchID = "";
    articleDiffRequestID = "";
    articleHasMore = false;
    articleTotalCount = 0;
    articleLoaded = false;
    articlePagingFailed = false;
    articlePages = new Set();
    articleMode.setAttribute("aria-pressed", String(next === "articles"));
    accountMode.setAttribute("aria-pressed", String(next === "accounts"));
    if (next === "accounts") {
      label.textContent = "公众号名称或微信号";
      input.placeholder = "例如：新智元";
      button.textContent = "搜索公众号";
      note.textContent = "通过电脑微信原生搜一搜定位公众号；选择账号后可浏览并批量下载该账号的文章。";
      status.textContent = "输入公众号名称或微信号开始搜索。";
    } else {
      label.textContent = "文章标题或内容关键词";
      input.placeholder = "例如：人工智能";
      button.textContent = "搜索微信文章";
      note.textContent = "工作台会把关键词发送到电脑微信的搜一搜文章接口；保持微信搜一搜页面打开即可。";
      status.textContent = "输入关键词开始搜索。";
    }
    results.replaceChildren();
    updateControls();
    input.focus();
  }

  async function searchAccounts(append = false) {
    const keyword = append ? accountQuery : input.value.trim();
    if (!keyword || downloading || searching) return;
    const current = ++sequence;
    searching = true;
    if (!append) {
      accountQuery = keyword;
      accountOffset = 0;
      accountCookies = "";
      accountSearchID = "";
      accountDiffRequestID = "";
      accountHasMore = false;
      accounts = [];
      results.replaceChildren();
    }
    status.textContent = append ? `正在加载更多与“${keyword}”相关的公众号…` : `正在通过电脑微信查找公众号“${keyword}”…`;
    updateControls();
    try {
      const params = new URLSearchParams({ keyword, offset: String(accountOffset) });
      if (accountCookies) params.set("cookies", accountCookies);
      if (accountSearchID) params.set("search_id", accountSearchID);
      if (accountDiffRequestID) params.set("diff_request_id", accountDiffRequestID);
      const data = await request(`/api/mp/account/search?${params}`, null, controller.signal);
      if (current !== sequence) return;
      const incoming = nativeAccounts(data);
      accounts = [...new Map([...accounts, ...incoming].map(account => [account.username, account])).values()];
      const page = nativeSearchPageState(data, accountOffset);
      accountOffset = page.nextOffset;
      accountCookies = page.cookies;
      accountSearchID = page.searchID;
      accountDiffRequestID = page.diffRequestID;
      accountHasMore = page.hasMore && incoming.length > 0 && accountOffset <= 1000;
      status.textContent = accounts.length ? `已找到 ${accounts.length} 个公众号${accountHasMore ? "，还可以继续加载" : ""}` : "微信已返回结果，但没有识别到公众号账号。";
      renderAccounts();
    } catch (error) {
      if (current === sequence && error.name !== "AbortError") status.textContent = `搜索公众号失败：${error.message || String(error)}`;
    } finally {
      if (current === sequence) { searching = false; updateControls(); }
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword || downloading || searching) return;
    if (mode === "accounts") { await searchAccounts(false); return; }
    const current = ++sequence;
    searching = true;
    view = "articles";
    status.textContent = `正在通过电脑微信搜一搜搜索“${keyword}”…`;
    articles = [];
    selected.clear();
    outcomes.clear();
    downloadStates.clear();
    renderArticles();
    try {
      const data = await request(`/api/mp/article/search?keyword=${encodeURIComponent(keyword)}`, null, controller.signal);
      if (current !== sequence) return;
      articles = nativeArticles(data);
      const statusReady = await refreshDownloadStates(articles);
      if (current !== sequence) return;
      status.textContent = (articles.length ? `微信搜一搜返回 ${articles.length} 篇公众号文章（当前页）` : "微信已返回结果，但尚未识别出可打开的公众号文章。") + (statusReady ? "" : " 本地下载状态核对失败，当前文章已暂停选择。");
      renderArticles();
    } catch (error) {
      if (current === sequence && error.name !== "AbortError") status.textContent = `搜索失败：${error.message || String(error)}`;
    } finally {
      if (current === sequence) { searching = false; updateControls(); }
    }
  });

  articleMode.addEventListener("click", () => setMode("articles"));
  accountMode.addEventListener("click", () => setMode("accounts"));
  moreAccounts.addEventListener("click", () => void searchAccounts(true));
  moreArticles.addEventListener("click", () => void loadAccountArticles(true));
  results.addEventListener("scroll", () => {
    if (mode !== "accounts" || !articleView() || !selectedAccount || !articleLoaded || !articleHasMore || searching || downloading || articlePagingFailed) return;
    if (results.scrollHeight - results.scrollTop - results.clientHeight < 120) void loadAccountArticles(true);
  }, { passive: true });
  backAccounts.addEventListener("click", () => {
    sequence++;
    selectedAccount = null;
    view = "accounts";
    articles = [];
    selected.clear();
    outcomes.clear();
    downloadStates.clear();
    articleOffset = 0;
    articleCookies = "";
    articleSearchID = "";
    articleDiffRequestID = "";
    articleHasMore = false;
    articleTotalCount = 0;
    articleLoaded = false;
    articlePagingFailed = false;
    articlePages = new Set();
    status.textContent = accounts.length ? `已找到 ${accounts.length} 个公众号${accountHasMore ? "，还可以继续加载" : ""}` : "输入公众号名称或微信号开始搜索。";
    renderAccounts();
  });

  selectAll.addEventListener("change", () => {
    selected = selectAll.checked
      ? new Set(articles.filter(isDownloadable).slice(0, 100).map(article => article.url))
      : new Set();
    renderArticles();
  });

  download.addEventListener("click", async () => {
    if (downloading) return;
    const chosen = articles.filter(article => selected.has(article.url) && isDownloadable(article)).slice(0, 100);
    if (!chosen.length) return;
    downloading = true;
    options.onDownloadStarted?.();
    status.textContent = `正在解析并创建下载任务（0/${chosen.length}）…`;
    renderArticles();
    let completed = 0;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    let cursor = 0;
    async function worker() {
      while (!controller.signal.aborted) {
        const index = cursor++;
        if (index >= chosen.length) return;
        const article = chosen[index];
        outcomes.set(article.url, { done: false, text: "正在解析正文并创建任务…" });
        renderArticles();
        try {
          const result = await downloadArticle(article, controller.signal);
          result.skipped ? skipped++ : added++;
          selected.delete(article.url);
          outcomes.set(article.url, { done: true, text: result.skipped ? `已有任务 #${result.id || ""}，已跳过` : `已加入任务 #${result.id || ""}` });
        } catch (error) {
          if (error.name === "AbortError") return;
          failed++;
          outcomes.set(article.url, { done: false, error: true, text: error.message || String(error) });
        }
        completed++;
        status.textContent = `正在解析并创建下载任务（${completed}/${chosen.length}）…`;
        renderArticles();
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, chosen.length) }, worker));
    if (controller.signal.aborted) return;
    downloading = false;
    status.textContent = `任务创建完成：新增 ${added} 篇，已有任务跳过 ${skipped} 篇，失败 ${failed} 篇。进度与操作见下方下载管理。`;
    renderArticles();
    try { await options.onTasksCreated?.(); }
    catch { status.textContent += " 下载进度刷新失败，请到“下载”页查看。"; }
  });

  updateControls();
  return { section, dispose() { controller.abort(); } };
}
