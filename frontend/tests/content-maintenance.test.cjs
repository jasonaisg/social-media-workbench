const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(name) {
  return fs.readFileSync(path.resolve(__dirname, `../src/pages/${name}`), 'utf8');
}

test('content library defaults to real downloads and refreshes while visible', () => {
  const model = source('content.model.js');
  assert.match(model, /const scope_ = ref\("downloaded"\)/);
  assert.match(model, /setInterval\(\(\) =>/);
  assert.match(model, /visibilityState !== "hidden"/);
  assert.match(model, /load\(page_\.value, \{ silent: true \}\)/);
});

test('content library exposes page selection and batch local-file deletion', () => {
  const model = source('content.model.js');
  const view = source('content.js');
  assert.match(model, /selected_content_ids_/);
  assert.match(model, /\/api\/content\/delete_downloads/);
  assert.match(view, /rowSelection:/);
  assert.match(view, /content-delete-selected-action/);
  assert.match(view, /DeleteContentsDialog|ContentDeleteConfirmDialog/);
});
