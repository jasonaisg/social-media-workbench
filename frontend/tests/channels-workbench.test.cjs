const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = '../public/channels-workbench.mjs';
test('workbench offers a dedicated native Channels bootstrap action', async () => {
  const { template } = await import(modulePath);
  assert.match(template, /id="open-channels"/);
  assert.match(template, />打开视频号</);
});
test('author search deduplicates contacts and accepts object results', async () => {
  const { contacts } = await import(modulePath);
  assert.deepEqual(contacts({ infoList: [{ contact: { username: 'a' } }, {}], objectList: [{ contact: { username: 'a' } }, { contact: { username: 'b' } }] }).map(x => x.username), ['a', 'b']);
});
test('keyword search extracts cross-author video objects and keeps full download payload', async () => {
  const { searchFeeds, taskBody } = await import(modulePath);
  const first = { id: '100', objectNonceId: 'n1', objectDesc: { mediaType: 4, description: '<em class="highlight">AI</em> 芯片', media: [{ url: 'https://example.com/1.mp4' }] } };
  const second = { id: '200', contact: { username: 'b@finder', nickname: 'B' }, objectDesc: { mediaType: 4, description: '#AI漫剧' } };
  const rows = searchFeeds({ objectList: [{ object: first, contact: { username: 'a@finder', nickname: 'A' } }, second, { id: '300', objectDesc: { mediaType: 2 } }, { id: '400', contact: { nickname: 'AI作者' }, objectDesc: { mediaType: 4, description: '育儿经验' } }], multiFeedStream: [second] }, 'ai');
  assert.deepEqual(rows.map(x => x.id), ['100', '200']);
  assert.equal(rows[0].contact.username, 'a@finder');
  assert.equal(rows[0].objectDesc.description, 'AI 芯片');
  assert.equal(first.objectDesc.description, '<em class="highlight">AI</em> 芯片');
  assert.equal(taskBody(rows).objects[0].content.objectDesc.media[0].url, first.objectDesc.media[0].url);
});
test('keyword filtering uses the work text, not the author name or unrelated recommendations', async () => {
  const { cleanSearchDescription, matchesSearchDescription } = await import(modulePath);
  assert.equal(cleanSearchDescription('  <em class="highlight">AI</em> &amp; 机器人\n'), 'AI & 机器人');
  assert.equal(matchesSearchDescription('#AI动画#原创', 'ai'), true);
  assert.equal(matchesSearchDescription('新能源制造企业管理', 'ai'), false);
  assert.equal(matchesSearchDescription('阿里达摩院发布医疗影像模型', 'ai'), false);
});
test('like ranking puts unknown values last without treating them as zero', async () => {
  const { sortFeedsByLikes } = await import(modulePath);
  const feeds = [{ id: 'missing', createtime: 5 }, { id: 'zero', createtime: 3 }, { id: 'high', createtime: 2 }, { id: 'mid', createtime: 1 }];
  const metrics = new Map([['zero', { counts: { favCount: 0 } }], ['high', { counts: { favCount: 120 } }], ['mid', { counts: { favCount: 12 } }]]);
  assert.deepEqual(sortFeedsByLikes(feeds, metrics).map(x => x.id), ['high', 'mid', 'zero', 'missing']);
  assert.deepEqual(feeds.map(x => x.id), ['missing', 'zero', 'high', 'mid']);
});
test('pagination stops on exhausted or repeated cursors', async () => {
  const { nextCursor } = await import(modulePath);
  assert.equal(nextCursor({ lastBuffer: 'a' }, 'a'), '');
  assert.equal(nextCursor({ lastBuff: 'b', continueFlag: 0 }, 'a', true), '');
  assert.equal(nextCursor({ lastBuffer: 'b' }, 'a'), 'b');
  assert.equal(nextCursor({ lastBuffer: 'c' }, 'a', true), 'c');
});
test('download uses native task API payload and explicitly skips existing files', async () => {
  const { taskBody, safeImage } = await import(modulePath);
  const content = { id: '18446744073709551610', objectDesc: { mediaType: 4 } };
  const body = taskBody([content]);
  assert.equal(body.objects[0].content.id, content.id);
  assert.equal(body.objects[0].config.existing_action, 'skip');
  assert.equal(body.objects[0].auto_start, true);
  assert.equal(safeImage('javascript:alert(1)'), '');
});
function bridge() {
  const messages = [], init = [];
  const logger = new Proxy({}, { get: () => () => logger });
  const WXU = { API: {}, API2: {}, log: logger, onInit: fn => init.push(fn), parseJSON: s => [null, JSON.parse(s)] };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; Socket.instance = this; }
    send(msg) { messages.push(JSON.parse(msg)); }
  }
  const context = vm.createContext({ WXU, __wx_username: 'self@finder', ChannelsEnv: { get: () => 'ws://localhost/ws/channels' }, WebSocket: Socket, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../pkg/scraper/wxchannels/inject/channels.ws.js'), 'utf8'), context);
  return { context, WXU, Socket, messages };
}
test('bridge works without a downloader UI and queries a different author', async () => {
  const { context, WXU, Socket, messages } = bridge();
  let received;
  WXU.API.finderUserPage = async p => { received = p; return { errCode: 0, data: { object: [] } }; };
  await context.ws_client$.methods.__wx_handle_api_call({ id: '1', key: 'key:channels:feed_list', data: { username: 'other@finder' } }, Socket.instance);
  assert.equal(received.username, 'other@finder');
  assert.equal(messages[0].data.errCode, 0);
  await context.ws_client$.methods.__wx_handle_api_call({ id: '2', key: 'key:channels:bridge_status' }, Socket.instance);
  assert.equal(messages[1].data.feeds_ready, true);
  assert.equal(messages[1].data.search_ready, false);
});
test('video search uses WeChat scene 19 and preserves the paging cursor', async () => {
  const { context, WXU, Socket, messages } = bridge();
  let received;
  WXU.API2.finderSearch = async payload => { received = payload; return { errCode: 0, data: { objectList: [] } }; };
  await context.ws_client$.methods.__wx_handle_api_call({ id: '3', key: 'key:channels:contact_list', data: { keyword: 'AI', type: 3, next_marker: 'next-page' } }, Socket.instance);
  assert.equal(received.scene, 19);
  assert.equal(received.lastBuff, 'next-page');
  assert.equal(received.lastBuffer, 'next-page');
  assert.equal(messages[0].data.errCode, 0);
});
test('uninitialized API replies with a useful error instead of timing out', async () => {
  const { Socket, messages } = bridge();
  Socket.instance.onmessage({ data: JSON.stringify({ type: 'api_call', data: { id: '7', key: 'key:channels:contact_list', data: { keyword: 'test' } } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].id, '7');
  assert.equal(messages[0].data.errCode, 1001);
  assert.match(messages[0].data.errMsg, /尚未就绪/);
});
test('download carries fetched metrics and timestamp without mutating original feeds', async () => {
  const { taskBody } = await import(modulePath);
  const feed = { id: '18446744073709551610' };
  const metrics = { counts: { favCount: 0, forwardCount: 12 }, fetched_at: 123, status: 'partial' };
  const sent = JSON.parse(JSON.stringify(taskBody([feed], new Map([[feed.id, metrics]]))));
  assert.deepEqual(sent.objects[0].content.wxchannels_metrics, metrics);
  assert.equal(feed.wxchannels_metrics, undefined);
});
