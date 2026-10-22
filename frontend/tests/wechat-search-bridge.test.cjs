const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('search bridge bootstraps the native template and preserves its security context', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/wechat_search_bridge.js'), 'utf8')
    .replace('__SPH_WS_URL__', JSON.stringify('ws://127.0.0.1:2022/ws/mp'));
  const socketMessages = [];
  const nativeCalls = [];
  const openedWindows = [];
  let socket;

  class MockSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = {}; socket = this; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    send(value) { socketMessages.push(JSON.parse(value)); }
    close() {}
  }
  class MockInput {
    set value(value) { this.currentValue = value; }
    get value() { return this.currentValue || ''; }
    dispatchEvent() {}
  }
  const input = new MockInput();
  const nativeTemplate = {
    req_json: JSON.stringify({
      Keyword: 'bootstrap',
      BusinessType: '2',
      Offset: 0,
      IsHomePage: 0,
      SearchID: '',
      SearchId: '',
      RequestId: 'first-request',
      Cookies: JSON.stringify({ query: 'bootstrap', businessType: 2, page_cnt: 0, cookies_buffer: 'first-page' }),
      Scene: 163,
      ExtReqParams: [
        { key: 'cookies', text_value: JSON.stringify({ query: 'bootstrap', businessType: 2, scene: 163 }) },
        { key: 'requestId', text_value: 'first-request' },
        { key: 'firstSearchRequest', uint_value: '1' },
      ],
    }),
    url: '/cgi-bin/mmsearch-bin/mmpcwebsearch',
    cgi_cmdid: 6423,
    h5Version: 80214151,
    scope: 'search',
    is_security_check: true,
  };
  const bridge = {
    invoke(method, args, callback) {
      nativeCalls.push({ method, args });
      callback?.({ err_msg: 'H5ExtTransfer:ok', jsapi_resp: { ret: 0, resp_json: '{}' } });
    },
  };
  const searchButton = {
    textContent: '搜索',
    getBoundingClientRect: () => ({ width: 70, height: 30 }),
    click: () => bridge.invoke('H5ExtTransfer', nativeTemplate, () => {}),
  };
  const context = {
    window: {
      WebSocket: MockSocket,
      WeixinJSBridge: bridge,
      HTMLInputElement: MockInput,
      Event: class {},
      KeyboardEvent: class {},
      open: (url, target) => openedWindows.push({ url, target }),
      document: {
        querySelector: () => input,
        querySelectorAll: () => [searchButton],
      },
    },
    self: {},
    WeixinJSBridge: bridge,
    WebSocket: MockSocket,
    structuredClone,
    JSON,
    Object,
    Array,
    String,
    Number,
    Promise,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(source, context);
  socket.listeners.open();
  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call',
    data: {
      id: 'request-1',
      key: 'key:jsapi',
      data: {
        operation: 'invoke',
        method: 'H5ExtTransfer',
        args: {
          req_json: JSON.stringify({
            Keyword: 'AI', BusinessType: '2', Offset: 20, IsHomePage: 0,
            Scene: 19,
            MatchUserList: [{ MatchWord: '', UserName: 'gh_exact' }],
            TagInfo: { TagText: 'AI', TagType: 4 },
            SearchID: 'search-session', SearchId: 'search-session', RequestId: 'next-request',
            SphDiffRequestId: 'first-request',
            Cookies: JSON.stringify({ query: 'AI', businessType: 2, page_cnt: 1, cookies_buffer: 'next-page' }),
            ExtReqParams: [{ key: 'docSortType', text_value: '["2"]' }],
          }),
          url: '/cgi-bin/mmsearch-bin/mmpcwebsearch',
        },
      },
    },
  }) });
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(input.value, 'AI');
  assert.equal(nativeCalls.length, 2);
  const replay = nativeCalls[1].args;
  const replayBody = JSON.parse(replay.req_json);
  assert.equal(replayBody.Keyword, 'AI');
  assert.equal(replayBody.Offset, 20);
  assert.equal(replayBody.SearchID, 'search-session');
  assert.equal(replayBody.SearchId, 'search-session');
  assert.equal(replayBody.RequestId, 'next-request');
  assert.equal(Object.hasOwn(replayBody, 'SphDiffRequestId'), false);
  assert.equal(JSON.parse(replayBody.Cookies).cookies_buffer, 'next-page');
  assert.equal(replayBody.Scene, 19);
  assert.deepEqual(replayBody.MatchUserList, [{ MatchWord: '', UserName: 'gh_exact' }]);
  assert.deepEqual(replayBody.TagInfo, { TagText: 'AI', TagType: 4 });
  const replayCookies = JSON.parse(replayBody.ExtReqParams[0].text_value);
  assert.equal(replayCookies.query, 'AI');
  assert.equal(replayCookies.page_cnt, 1);
  assert.equal(replayCookies.cookies_buffer, 'next-page');
  assert.equal(replayBody.ExtReqParams[1].text_value, 'next-request');
  assert.equal(replayBody.ExtReqParams[2].uint_value, '0');
  const extParams = new Map(replayBody.ExtReqParams.map(item => [item.key, item]));
  assert.equal(extParams.get('currentPage').uint_value, '2');
  assert.equal(extParams.get('diffRequestId').text_value, 'first-request');
  assert.equal(extParams.get('notFirstSearchAction').uint_value, '0');
  assert.equal(extParams.get('docSortType').text_value, '["2"]');
  assert.equal(replay.h5Version, 80214151);
  assert.ok(socketMessages.some(message => message.id === 'request-1' && message.data.errCode === 0));

  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call', data: { id: 'open-history', key: 'key:jsapi', data: {
      operation: 'invoke', method: 'openUrlWithExtraWebview',
      args: { url: 'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=test', openType: 1 },
    } },
  }) });
  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call', data: { id: 'reject-history', key: 'key:jsapi', data: {
      operation: 'invoke', method: 'openUrlWithExtraWebview',
      args: { url: 'https://example.com/mp/profile_ext?__biz=test' },
    } },
  }) });
  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call', data: { id: 'open-finder-profile', key: 'key:jsapi', data: {
      operation: 'invoke', method: 'openFinderProfile',
      args: { userName: 'v2_test@finder' },
    } },
  }) });
  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call', data: { id: 'reject-finder-profile', key: 'key:jsapi', data: {
      operation: 'invoke', method: 'openFinderProfile',
      args: { userName: '../unsafe@finder' },
    } },
  }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(nativeCalls.some(call => call.method === 'openUrlWithExtraWebview'));
  assert.ok(socketMessages.some(message => message.id === 'open-history' && message.data.errCode === 0));
  assert.ok(socketMessages.some(message => message.id === 'reject-history' && message.data.errCode !== 0));
  assert.ok(socketMessages.some(message => message.id === 'open-finder-profile' && message.data.errCode === 0));
  assert.ok(socketMessages.some(message => message.id === 'reject-finder-profile' && message.data.errCode !== 0));
  assert.equal(nativeCalls.some(call => call.method === 'openFinderProfile'), false);
  const finderOpenCall = nativeCalls.find(call =>
    call.method === 'openUrl'
    && call.args?.url?.startsWith('https://channels.weixin.qq.com/'));
  assert.equal(finderOpenCall.method, 'openUrl');
  assert.equal(
    finderOpenCall.args.url,
    'https://channels.weixin.qq.com/web/pages/profile?username=v2_test%40finder',
  );
  assert.equal(finderOpenCall.args.openType, undefined);
  assert.deepEqual(openedWindows, []);
});

test('search bridge reuses a peer template without touching the visible WeChat search box', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/wechat_search_bridge.js'), 'utf8')
    .replace('__SPH_WS_URL__', JSON.stringify('ws://127.0.0.1:2022/ws/mp'));
  const nativeTemplate = {
    req_json: JSON.stringify({ Keyword: 'peer', BusinessType: '2', Offset: 0, RequestId: 'peer-request', ExtReqParams: [] }),
    url: '/cgi-bin/mmsearch-bin/mmpcwebsearch', h5Version: 80214151, is_security_check: true,
  };
  let socket;
  let inputWrites = 0;
  const nativeCalls = [];
  const socketMessages = [];
  class MockSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = {}; socket = this; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    send(value) { socketMessages.push(JSON.parse(value)); }
    close() {}
  }
  class MockBroadcastChannel {
    addEventListener(name, handler) { if (name === 'message') this.handler = handler; }
    postMessage(message) {
      if (message.type === 'request') setTimeout(() => this.handler({ data: { type: 'template', template: nativeTemplate } }), 0);
    }
  }
  class MockInput {
    set value(value) { inputWrites += 1; this.currentValue = value; }
    get value() { return this.currentValue || ''; }
    dispatchEvent() {}
  }
  const bridge = {
    invoke(method, args, callback) {
      nativeCalls.push({ method, args });
      callback?.({ err_msg: `${method}:ok` });
    },
  };
  const context = {
    window: {
      WebSocket: MockSocket, BroadcastChannel: MockBroadcastChannel, WeixinJSBridge: bridge,
      HTMLInputElement: MockInput, Event: class {}, KeyboardEvent: class {},
      document: { querySelector: () => new MockInput(), querySelectorAll: () => [] },
    },
    self: {}, WeixinJSBridge: bridge, WebSocket: MockSocket, structuredClone,
    JSON, Object, Array, String, Number, Promise, URL, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
  };
  vm.runInNewContext(source, context);
  socket.listeners.open();
  socket.listeners.message({ data: JSON.stringify({
    type: 'api_call', data: { id: 'peer-search', key: 'key:jsapi', data: {
      operation: 'invoke', method: 'H5ExtTransfer',
      args: { url: '/cgi-bin/mmsearch-bin/mmpcwebsearch', req_json: JSON.stringify({ Keyword: 'AI', BusinessType: '2', Offset: 0 }) },
    } },
  }) });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(inputWrites, 0);
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].args.h5Version, 80214151);
  assert.equal(JSON.parse(nativeCalls[0].args.req_json).Keyword, 'AI');
  assert.ok(socketMessages.some(message => message.id === 'peer-search' && message.data.errCode === 0));
});
