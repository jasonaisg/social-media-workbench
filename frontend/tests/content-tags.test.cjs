const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) {
  return fs.readFileSync(path.resolve(__dirname, `../src/pages/${name}`), "utf8");
}

async function loadTagModel() {
  const code = source("content-tags.model.js");
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("content tags normalize JSON and arrays without duplicates", async () => {
  const { normalizeContentTags, stripContentTags } = await loadTagModel();
  assert.deepEqual(normalizeContentTags('["AI"," AI ","#大模型",""]'), [
    "AI",
    "大模型",
  ]);
  assert.deepEqual(normalizeContentTags(["新闻", "科普", "新闻"]), [
    "新闻",
    "科普",
  ]);
  assert.deepEqual(normalizeContentTags("not-json"), []);
  assert.deepEqual(normalizeContentTags(null), []);
  assert.equal(
    stripContentTags("视频标题 #AI #AI工具 #大模型", ["AI", "AI工具", "大模型"]),
    "视频标题",
  );
});

test("content list and detail render topic tags immediately below title", () => {
  const list = source("content.js");
  const detail = source("content_detail.js");
  const listModel = source("content.model.js");
  const detailModel = source("content_detail.model.js");
  const metrics = source("content-metrics.js");
  const styles = fs.readFileSync(
    path.resolve(__dirname, "../src/style.css"),
    "utf8",
  );

  assert.ok(list.indexOf('class: "content-row-title"') >= 0);
  assert.ok(
    list.indexOf('name: "content-row-topic-tags"') >
      list.indexOf('class: "content-row-title"'),
  );
  assert.ok(detail.indexOf('class: "content-detail-title"') >= 0);
  assert.ok(
    detail.indexOf('name: "content-detail-topic-tags"') >
      detail.indexOf('class: "content-detail-title"'),
  );
  assert.match(styles, /\.content-topic-tags\s*\{/);
  assert.match(styles, /\.content-topic-tag\s*\{/);
  assert.match(listModel, /tags:\s*normalizeContentTags/);
  assert.match(detailModel, /tags:\s*normalizeContentTags/);
  assert.match(metrics, /stripContentTags\(description, content\.tags\)/);
});
