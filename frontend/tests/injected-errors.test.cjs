const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function capture() {
  const listeners = {};
  const logs = [];
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inject/error.js'), 'utf8'), {
    window, console: { error: (...args) => logs.push(args) },
  });
  // Rendering is irrelevant here: asserting no render is what protects the
  // host document from the injected modal and body overflow changes.
  const renders = [];
  window.errorModal.setView({ render: state => renders.push(state) });
  return { window, listeners, logs, renders };
}

test('host resource failures remain logged without opening an overlay', () => {
  const c = capture();
  for (const tagName of ['IMG', 'IFRAME', 'SCRIPT', 'LINK']) {
    c.listeners.error({ target: { tagName, src: 'https://mp.weixin.qq.com/s?example=1' } });
  }
  assert.equal(c.logs.length, 4);
  assert.equal(c.renders.length, 0);
  assert.equal(c.window.errorModal.visible, false);
  assert.equal(c.window.errorModal.errors.length, 0);
});

test('runtime errors and rejected promises retain debugging feedback', () => {
  const c = capture();
  c.listeners.error({ target: c.window, error: new Error('runtime failed') });
  c.listeners.unhandledrejection({ reason: new Error('request failed') });
  assert.equal(c.renders.length, 2);
  assert.equal(c.window.errorModal.errors[0].msg, 'runtime failed');
  assert.equal(c.window.errorModal.errors[1].msg, 'request failed');
});
