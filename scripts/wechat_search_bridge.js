/* __SPH_WECHAT_SEARCH_BRIDGE_START__ */
(() => {
  const root = typeof window !== "undefined" ? window : self;
  if (root.__sph_wechat_search_bridge__) return;
  root.__sph_wechat_search_bridge__ = true;
  const WS_URL = __SPH_WS_URL__;
  const TITLE = "微信搜一搜桥接";
  const TEMPLATE_CHANNEL = "sph-wechat-search-template-v1";
  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let searchTemplate = null;
  let firstSearchTemplate = null;
  let paginationSearchTemplate = null;
  let bridgeCallActive = false;
  let hookedBridge = null;
  let templateBus = null;

  const send = value => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const ping = () => {
    send({ type: "ping", data: TITLE });
  };
  const response = (id, data) => send({ id, data });
  const bridge = () => root.WeixinJSBridge || (typeof WeixinJSBridge !== "undefined" ? WeixinJSBridge : null);

  function clone(value) {
    try { return structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; } }
  }

  function rememberNativeSearchTemplate(args, broadcast = true) {
    const captured = clone(args);
    if (!captured) return;
    searchTemplate = captured;
    try {
      const body = JSON.parse(captured.req_json || "{}");
      if (Number(body.Offset ?? body.offset) > 0) paginationSearchTemplate = captured;
      else firstSearchTemplate = captured;
    } catch (_) {}
    root.__sph_wechat_search_template__ = captured;
    if (broadcast && templateBus) {
      try { templateBus.postMessage({ type: "template", template: captured }); } catch (_) {}
    }
  }

  function installTemplateSharing() {
    if (typeof root.BroadcastChannel !== "function") return;
    try {
      templateBus = new root.BroadcastChannel(TEMPLATE_CHANNEL);
      templateBus.addEventListener("message", event => {
        const message = event?.data;
        if (message?.type === "request") {
          const template = firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__;
          if (template) {
            try { templateBus.postMessage({ type: "template", template: clone(template) }); } catch (_) {}
          }
        } else if (message?.type === "template" && message.template) {
          rememberNativeSearchTemplate(message.template, false);
        }
      });
    } catch (_) {
      templateBus = null;
    }
  }

  async function requestTemplateFromPeers() {
    if (firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__) return true;
    if (!templateBus) return false;
    try { templateBus.postMessage({ type: "request" }); } catch (_) { return false; }
    for (let attempts = 0; attempts < 4; attempts += 1) {
      await wait(50);
      if (firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__) return true;
    }
    return false;
  }

  function hookNativeSearch() {
    const api = bridge();
    if (!api || api === hookedBridge || typeof api.invoke !== "function") return;
    const originalInvoke = api.invoke;
    api.invoke = function (method, args) {
      if (!bridgeCallActive && method === "H5ExtTransfer" && String(args?.url || "").includes("mmpcwebsearch")) {
        rememberNativeSearchTemplate(args);
      }
      return originalInvoke.apply(this, arguments);
    };
    hookedBridge = api;
  }

  function nativeSearchArgs(args) {
    if (!String(args?.url || "").includes("mmpcwebsearch")) return args;
    try {
      const requestedBody = JSON.parse(args.req_json || "{}");
      const requestedOffset = Number(requestedBody.Offset ?? requestedBody.offset) || 0;
      const template = requestedOffset > 0
        ? paginationSearchTemplate || firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__
        : firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__;
      if (!template) return args;
      const templateBody = JSON.parse(template.req_json || "{}");
      const mergedBody = { ...templateBody };
      for (const key of ["Keyword", "BusinessType", "Offset", "IsHomePage", "Scene", "Cookies", "SearchID", "SearchId", "searchID", "searchId", "RequestId", "RequestID", "requestId", "MatchUserList", "TagInfo"]) {
        if (Object.prototype.hasOwnProperty.call(requestedBody, key)) mergedBody[key] = requestedBody[key];
      }
      const keyword = String(requestedBody.Keyword ?? requestedBody.keyword ?? mergedBody.Keyword ?? mergedBody.keyword ?? "");
      const businessType = requestedBody.BusinessType ?? requestedBody.businessType ?? mergedBody.BusinessType ?? mergedBody.businessType;
      const requestId = String(requestedBody.RequestId ?? requestedBody.RequestID ?? requestedBody.requestId ?? "");
      const searchId = String(requestedBody.SearchID ?? requestedBody.SearchId ?? requestedBody.searchID ?? requestedBody.searchId ?? "");
      const diffRequestId = String(requestedBody.SphDiffRequestId || requestId);
      if (searchId) {
        mergedBody.SearchID = searchId;
        mergedBody.SearchId = searchId;
      }
      if (requestId) mergedBody.RequestId = requestId;
      delete mergedBody.SphDiffRequestId;

      const setTextValue = (item, value) => {
        if (Object.prototype.hasOwnProperty.call(item, "textValue")) item.textValue = String(value);
        else item.text_value = String(value);
      };
      const setUintValue = (item, value) => {
        if (Object.prototype.hasOwnProperty.call(item, "uintValue")) item.uintValue = String(value);
        else item.uint_value = String(value);
      };
      const requestedCookies = typeof requestedBody.Cookies === "string" && requestedBody.Cookies.trim()
        ? requestedBody.Cookies
        : "";
      let cookieState = null;
      try { cookieState = JSON.parse(requestedCookies); } catch (_) {}
      if (cookieState) {
        if (keyword) cookieState.query = keyword;
        if (businessType != null) cookieState.businessType = Number(businessType);
      }
      const cookies = cookieState ? JSON.stringify(cookieState) : requestedCookies;
      const currentPage = requestedOffset > 0
        ? Math.max(2, Number(cookieState?.page_cnt || 1) + 1)
        : 1;
      {
        mergedBody.ExtReqParams = (Array.isArray(templateBody.ExtReqParams) ? templateBody.ExtReqParams : []).map(item => {
          const next = { ...item };
          const key = String(next.key ?? next.Key ?? "");
          if (key === "firstSearchQuery" && keyword) setTextValue(next, keyword);
          if (key === "requestId" && requestId) setTextValue(next, requestId);
          if (key === "diffRequestId" && diffRequestId) setTextValue(next, diffRequestId);
          if (key === "cookies" && cookies) setTextValue(next, cookies);
          if (key === "currentPage") setUintValue(next, currentPage);
          if (key === "firstSearchRequest") setUintValue(next, requestedOffset > 0 ? 0 : 1);
          if (key === "notFirstSearchAction") setUintValue(next, 0);
          return next;
        });

        // Filter parameters belong to the requested search, not to the
        // captured bootstrap template. Merge them explicitly so account-feed
        // requests can select WeChat's native "最新发布" ordering. Without this,
        // requested ExtReqParams are silently replaced by the template and the
        // backend falls back to relevance ordering.
        for (const requested of Array.isArray(requestedBody.ExtReqParams) ? requestedBody.ExtReqParams : []) {
          if (!requested || typeof requested !== "object") continue;
          const key = String(requested.key ?? requested.Key ?? "");
          if (!key) continue;
          const existing = mergedBody.ExtReqParams.find(item => String(item.key ?? item.Key ?? "") === key);
          if (existing) {
            if (requested.textValue !== undefined || requested.text_value !== undefined) {
              setTextValue(existing, requested.textValue ?? requested.text_value);
            }
            if (requested.uintValue !== undefined || requested.uint_value !== undefined) {
              setUintValue(existing, requested.uintValue ?? requested.uint_value);
            }
          } else {
            mergedBody.ExtReqParams.push({ ...requested });
          }
        }

        const upsertText = (key, value) => {
          if (!value || mergedBody.ExtReqParams.some(item => String(item.key ?? item.Key ?? "") === key)) return;
          mergedBody.ExtReqParams.push({ key, text_value: String(value) });
        };
        const upsertUint = (key, value) => {
          if (mergedBody.ExtReqParams.some(item => String(item.key ?? item.Key ?? "") === key)) return;
          mergedBody.ExtReqParams.push({ key, uint_value: String(value) });
        };
        upsertText("cookies", cookies);
        upsertText("requestId", requestId);
        upsertText("diffRequestId", diffRequestId);
        upsertText("firstSearchQuery", keyword);
        upsertUint("currentPage", currentPage);
        upsertUint("firstSearchRequest", requestedOffset > 0 ? 0 : 1);
        upsertUint("notFirstSearchAction", 0);
      }
      return {
        ...template,
        req_json: JSON.stringify(mergedBody),
      };
    } catch (_) {
      return args;
    }
  }

  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  async function ensureSearchTemplate(args) {
    if (!String(args?.url || "").includes("mmpcwebsearch")) return;
    if (firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__) return;
    if (await requestTemplateFromPeers()) return;
    let keyword = "";
    try { keyword = String(JSON.parse(args.req_json || "{}").Keyword || "").trim(); } catch (_) {}
    if (!keyword || !root.document) return;
    const input = root.document.querySelector('input[type="search"], input[type="text"], input');
    if (!input) return;
    try {
      const setter = Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, keyword);
      else input.value = keyword;
      input.dispatchEvent(new root.Event("input", { bubbles: true }));
      input.dispatchEvent(new root.Event("change", { bubbles: true }));
      await wait(50);
      const candidates = Array.from(root.document.querySelectorAll('button, [role="button"], a, div, span'));
      const searchButton = candidates.find(element => {
        const rect = element.getBoundingClientRect?.();
        return element.textContent?.trim() === "搜索" && rect && rect.width > 0 && rect.height > 0;
      });
      if (searchButton) searchButton.click();
      else {
        for (const type of ["keydown", "keypress", "keyup"]) {
          input.dispatchEvent(new root.KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
      }
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__) return;
        await wait(100);
      }
    } catch (_) {}
  }

  async function invoke(request) {
    await ensureSearchTemplate(request.args || {});
    return new Promise((resolve, reject) => {
      const api = bridge();
      if (!api || typeof api.invoke !== "function") {
        reject(new Error("微信搜一搜 JSBridge 尚未就绪"));
        return;
      }
      const timeout = Math.min(Math.max(Number(request.timeout_ms) || 25000, 1000), 120000);
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          bridgeCallActive = false;
          reject(new Error("微信搜一搜请求超时"));
        }
      }, timeout);
      try {
        bridgeCallActive = true;
        api.invoke(request.method, nativeSearchArgs(request.args || {}), function () {
          bridgeCallActive = false;
          if (done) return;
          done = true;
          clearTimeout(timer);
          const results = Array.from(arguments);
          resolve({ method: request.method, result: results[0] || null, results });
        });
      } catch (error) {
        bridgeCallActive = false;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function assertSafeNavigation(request) {
    if (request.method !== "openUrlWithExtraWebview") return false;
    let target;
    try { target = new URL(String(request.args?.url || "")); }
    catch (_) { throw new Error("原生页面地址无效"); }
    if (target.protocol !== "https:") {
      throw new Error("原生页面地址必须使用 HTTPS");
    }
    if (target.hostname !== "mp.weixin.qq.com") {
      throw new Error("公众号历史消息地址必须来自 mp.weixin.qq.com");
    }
    if (!["/mp/profile_ext", "/mp/getmasssendmsg"].includes(target.pathname)) {
      throw new Error("仅允许打开公众号历史消息页");
    }
    if (!target.searchParams.get("__biz")) {
      throw new Error("公众号历史消息地址缺少 __biz");
    }
    return true;
  }

  function assertSafeFinderProfile(request) {
    if (request.method !== "openFinderProfile") return false;
    const username = String(request.args?.userName || "").trim();
    if (!/^[A-Za-z0-9_]+@finder$/.test(username) || username.length > 256) {
      throw new Error("视频号作者标识无效");
    }
    return true;
  }

  async function openSafeFinderProfile(request) {
    assertSafeFinderProfile(request);
    const username = String(request.args.userName).trim();
    const target = new URL("https://channels.weixin.qq.com/web/pages/profile");
    target.searchParams.set("username", username);
    const api = bridge();
    if (!api || typeof api.invoke !== "function") {
      throw new Error("微信搜一搜 JSBridge 尚未就绪，无法打开视频号");
    }

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("微信打开视频号页面超时"));
        }
      }, 8000);
      try {
        api.invoke("openUrl", { url: target.href }, value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const message = String(value?.err_msg || value?.errMsg || "");
          if (/fail|cancel/i.test(message)) {
            reject(new Error(message));
            return;
          }
          resolve(value || { err_msg: "openUrl:ok" });
        });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    return { method: "openUrl", result, results: [result] };
  }
  setInterval(hookNativeSearch, 500);
  hookNativeSearch();

  async function handle(message) {
    if (!message || message.type !== "api_call" || !message.data) return;
    const { id, key, data } = message.data;
    if (key !== "key:jsapi") {
      response(id, { errCode: 1000, errMsg: "微信搜一搜桥接不支持该请求" });
      return;
    }
    try {
      const request = data || {};
      if (request.operation === "ready") {
        response(id, { errCode: 0, data: { bridge_available: !!bridge(), template_available: !!(firstSearchTemplate || searchTemplate || root.__sph_wechat_search_template__) } });
        return;
      }
      if (request.operation !== "invoke") {
        throw new Error("微信搜一搜桥接仅支持原生搜索和受限页面导航");
      }
      if (request.method !== "H5ExtTransfer" && !assertSafeNavigation(request) && !assertSafeFinderProfile(request)) {
        throw new Error("微信搜一搜桥接不支持该 JSAPI");
      }
      if (request.method === "openFinderProfile") {
        response(id, { errCode: 0, data: await openSafeFinderProfile(request) });
        return;
      }
      response(id, { errCode: 0, data: await invoke(request) });
    } catch (error) {
      response(id, { errCode: 1103, errMsg: error instanceof Error ? error.message : String(error) });
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      socket = new root.WebSocket(WS_URL);
      socket.addEventListener("open", () => {
        ping();
        clearInterval(pingTimer);
        pingTimer = setInterval(ping, 5000);
      });
      socket.addEventListener("message", event => {
        try { void handle(JSON.parse(event.data)); } catch (_) {}
      });
      socket.addEventListener("close", () => {
        clearInterval(pingTimer);
        reconnectTimer = setTimeout(connect, 3000);
      });
      socket.addEventListener("error", () => {
        try { socket.close(); } catch (_) {}
      });
    } catch (_) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  }
  installTemplateSharing();
  connect();
})();
/* __SPH_WECHAT_SEARCH_BRIDGE_END__ */
