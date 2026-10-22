const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('official-account cards do not expose the misleading history shortcut', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../public/mp-article-search.mjs'), 'utf8');
  assert.doesNotMatch(source, /微信历史消息/);
  assert.doesNotMatch(source, /actions\.append\(profile\)/);
});

test('native article results only include WeChat public-account links', async () => {
  const { nativeArticles } = await import('../public/mp-article-search.mjs');
  const result = nativeArticles({ data: [{ items: [
    { title: '<em>AI</em> 新进展', bizName: '科技日报', digest: '关于 AI &amp; 科研', url: 'https://mp.weixin.qq.com/s/abc' },
    { title: '普通网站', url: 'https://example.com/article' },
    { title: '危险链接', url: 'javascript:alert(1)' },
  ] }] });
  assert.deepEqual(result, [{ title: 'AI 新进展', author: '科技日报', excerpt: '关于 AI & 科研', url: 'https://mp.weixin.qq.com/s/abc' }]);
});

test('collected article excerpts are preserved', async () => {
  const { nativeArticles } = await import('../public/mp-article-search.mjs');
  const result = nativeArticles({ articles: [{ title: 'AI 原文', author: '示例号', excerpt: '核验后的文章摘要', url: 'https://mp.weixin.qq.com/s/example' }] });
  assert.equal(result[0].excerpt, '核验后的文章摘要');
});

test('native WeChat doc_url results include title, account and excerpt', async () => {
  const { nativeArticles } = await import('../public/mp-article-search.mjs');
  const result = nativeArticles({ data: [{ items: [{
    title: '<em class="highlight">AI</em>技术每日分析',
    desc: '今日<em class="highlight">AI</em>技术变化',
    doc_url: 'http://mp.weixin.qq.com/s?__biz=test&mid=1',
    source: { title: '测试公众号' },
  }] }] });
  assert.deepEqual(result, [{
    title: 'AI技术每日分析',
    author: '测试公众号',
    excerpt: '今日AI技术变化',
    url: 'https://mp.weixin.qq.com/s?__biz=test&mid=1',
  }]);
});

test('native article results preserve publish time and sort newest first', async () => {
  const { nativeArticles, sortArticlesByTime } = await import('../public/mp-article-search.mjs');
  const result = nativeArticles({ items: [{
    title: '较早文章', doc_url: 'https://mp.weixin.qq.com/s?__biz=one&mid=1', publish_time: 1760000000,
  }, {
    title: '最新文章', doc_url: 'https://mp.weixin.qq.com/s?__biz=one&mid=2', publishTime: 1770000000000,
  }, {
    title: '时间未知', doc_url: 'https://mp.weixin.qq.com/s?__biz=one&mid=3',
  }] });
  assert.deepEqual(sortArticlesByTime(result).map(article => [article.title, article.publishedAt || 0]), [
    ['最新文章', 1770000000],
    ['较早文章', 1760000000],
    ['时间未知', 0],
  ]);
});

test('native search pagination keeps the next offset, cookies and native request session', async () => {
  const { nativeSearchPageState } = await import('../public/mp-article-search.mjs');
  assert.deepEqual(nativeSearchPageState({ continueFlag: 1, offset: 40, cookies: 'opaque', searchID: 'session-2', _sphDiffRequestId: 'first-request' }, 20), {
    hasMore: true,
    nextOffset: 40,
    cookies: 'opaque',
    searchID: 'session-2',
    diffRequestID: 'first-request',
  });
  assert.deepEqual(nativeSearchPageState({ continueFlag: 1, offset: 20 }, 20), {
    hasMore: true,
    nextOffset: 40,
    cookies: '',
    searchID: '',
    diffRequestID: '',
  });
  assert.equal(nativeSearchPageState({ continueFlag: 0, offset: 60 }, 40).hasMore, false);
});

test('native account feed exposes the largest reported total count', async () => {
  const { nativeSearchTotalCount } = await import('../public/mp-article-search.mjs');
  assert.equal(nativeSearchTotalCount({ data: [{ totalCount: 596 }, { totalCount: 12 }] }), 596);
  assert.equal(nativeSearchTotalCount({ data: [{ total_count: '310' }] }), 310);
  assert.equal(nativeSearchTotalCount({ data: [] }), 0);
});

test('account feed uses WeChat unfiltered sentinel and normalizes local archive status', async () => {
  const { officialAccountFeedKeyword, articleDownloadState } = await import('../public/mp-article-search.mjs');
  assert.equal(officialAccountFeedKeyword, 'EMPTY_QUERY_PLACEHOLDER');
  const url = 'https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1';
  assert.equal(articleDownloadState({ statuses: { [url]: 'downloaded' } }, url), 'downloaded');
  assert.equal(articleDownloadState({ statuses: { [url]: 'not_downloaded' } }, url), 'not_downloaded');
  assert.equal(articleDownloadState({ statuses: { [url]: 'unexpected' } }, url), 'unknown');
});

test('native account results preserve official-account identity and safe profile fields', async () => {
  const { nativeAccounts } = await import('../public/mp-article-search.mjs');
  const result = nativeAccounts({ data: [{ subBoxes: [{ items: [{
    title: '<em>新智元</em>',
    desc: '专注人工智能产业',
    iconUrl: 'https://ignored.example/avatar.png',
    jumpInfo: {
      nickName: '<em>新智元</em>',
      aliasName: 'AI_era',
      userName: 'gh_108f2a2a27f4',
      bizuin: '3271041950',
      headImgUrl: 'http://wx.qlogo.cn/mmhead/example/0',
      signature: '智能改变世界',
      externalInfo: { authInfo: '北京中经智元科技发展有限公司' },
      brandInfo: { urls: [{ url: 'http://mp.weixin.qq.com/mp/getmasssendmsg?__biz=test' }] },
    },
  }, {
    title: '重复结果',
    jumpInfo: { nickName: '重复结果', userName: 'gh_108f2a2a27f4' },
  }] }] }] });
  assert.deepEqual(result, [{
    username: 'gh_108f2a2a27f4',
    nickname: '新智元',
    alias: 'AI_era',
    bizuin: '3271041950',
    avatar: 'https://wx.qlogo.cn/mmhead/example/0',
    description: '智能改变世界',
    verification: '北京中经智元科技发展有限公司',
    profileURL: 'https://mp.weixin.qq.com/mp/getmasssendmsg?__biz=test',
  }]);
});

test('articles selected from an account search only keep the chosen publisher', async () => {
  const { articlesForAccount } = await import('../public/mp-article-search.mjs');
  const payload = { data: [{ items: [
    { title: '新智元文章', doc_url: 'https://mp.weixin.qq.com/s?__biz=MzI3MTA0MTk1MA==&mid=1', source: { title: '新智元' } },
    { title: '相似名称', doc_url: 'https://mp.weixin.qq.com/s?__biz=MzY0MDEwMTUzNg==&mid=2', source: { title: '新智元生物' } },
    { title: '其他文章', doc_url: 'https://mp.weixin.qq.com/s/b', source: { title: '机器之心' } },
  ] }] };
  assert.deepEqual(articlesForAccount(payload, { nickname: '新智元', bizuin: '3271041950' }), [{
    title: '新智元文章', author: '新智元', excerpt: '', url: 'https://mp.weixin.qq.com/s?__biz=MzI3MTA0MTk1MA==&mid=1',
  }]);
});

test('native account parser accepts WeChat JSON-string brand and verification fields', async () => {
  const { nativeAccounts } = await import('../public/mp-article-search.mjs');
  const result = nativeAccounts({ items: [{
    title: '新智元', source: { title: '北京中经智元科技发展有限公司' },
    jumpInfo: {
      nickName: '新智元', userName: 'gh_108f2a2a27f4', bizuin: '3271041950',
      headHDImgUrl: 'http://wx.qlogo.cn/mmhead/hd/0',
      brandInfo: '{"urls":[{"url":"http://mp.weixin.qq.com/mp/getmasssendmsg?__biz=MzI3MTA0MTk1MA=="}]}',
      externalInfo: '{"VerifySource":{"Description":"北京中经智元科技发展有限公司"}}',
    },
  }] });
  assert.equal(result[0].avatar, 'https://wx.qlogo.cn/mmhead/hd/0');
  assert.equal(result[0].verification, '北京中经智元科技发展有限公司');
  assert.equal(result[0].profileURL, 'https://mp.weixin.qq.com/mp/getmasssendmsg?__biz=MzI3MTA0MTk1MA==');
});

test('article task body reuses the wxmp fetch result and starts the task', async () => {
  const { articleTaskBody } = await import('../public/mp-article-search.mjs');
  const fetched = { title: 'AI 原文', bizuin: 'biz', mid: 123, idx: 1 };
  assert.deepEqual(articleTaskBody(fetched), {
    objects: [{
      platform: 'wxmp',
      content: fetched,
      build_from_fetch: true,
      config: { skip: true, existing_action: 'skip' },
      auto_start: true,
    }],
  });
});

test('official-account history parser expands main and secondary articles', async () => {
  const { officialAccountHistoryArticles, officialAccountHistoryPageState } = await import('../public/mp-article-search.mjs');
  const payload = {
    can_msg_continue: 1,
    next_offset: 10,
    general_msg_list: JSON.stringify({ list: [{
      comm_msg_info: { datetime: 1770000000 },
      app_msg_ext_info: {
        title: '主文章', author: '', digest: '主摘要',
        content_url: 'http://mp.weixin.qq.com/s?__biz=test&amp;mid=1',
        multi_app_msg_item_list: [{
          title: '次文章', author: '专栏作者', digest: '次摘要',
          content_url: 'https://mp.weixin.qq.com/s?__biz=test&amp;mid=2',
        }],
      },
    }] }),
  };
  assert.deepEqual(officialAccountHistoryArticles(payload, { nickname: '三零年代' }), [{
    title: '主文章', author: '三零年代', excerpt: '主摘要',
    url: 'https://mp.weixin.qq.com/s?__biz=test&mid=1', publishedAt: 1770000000,
  }, {
    title: '次文章', author: '专栏作者', excerpt: '次摘要',
    url: 'https://mp.weixin.qq.com/s?__biz=test&mid=2', publishedAt: 1770000000,
  }]);
  assert.deepEqual(officialAccountHistoryPageState(payload, 0), { hasMore: true, nextOffset: 10 });
  assert.deepEqual(officialAccountHistoryPageState({ can_msg_continue: 0 }, 10), { hasMore: false, nextOffset: 20 });
});

test('history biz prefers the profile URL and falls back to encoded bizuin', async () => {
  const { accountHistoryBiz } = await import('../public/mp-article-search.mjs');
  assert.equal(accountHistoryBiz({ profileURL: 'https://mp.weixin.qq.com/mp/getmasssendmsg?__biz=MzA3NDAyNzU2NQ%3D%3D', bizuin: '1' }), 'MzA3NDAyNzU2NQ==');
  assert.equal(accountHistoryBiz({ bizuin: '3074027565' }), 'MzA3NDAyNzU2NQ==');
});
