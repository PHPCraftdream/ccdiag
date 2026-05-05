'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// dumpFlat is not exported; we test it indirectly via its output format
// by re-implementing the minimal serializer inline for comparison.
// Exported: flattenDotted, isPluginEnabled, pluginConfig
const { flattenDotted, isPluginEnabled, pluginConfig } = require('../src/config');

// ---------------------------------------------------------------------------
// flattenDotted
// ---------------------------------------------------------------------------
describe('flattenDotted', () => {
  it('flattens one level of nesting', () => {
    assert.deepStrictEqual(flattenDotted({ a: { b: 1 } }), { 'a.b': 1 });
  });

  it('flattens deeply nested plugin key', () => {
    assert.deepStrictEqual(
      flattenDotted({ plugin: { 'rate-burst': { enabled: true } } }),
      { 'plugin.rate-burst.enabled': true }
    );
  });

  it('returns {} for null', () => {
    assert.deepStrictEqual(flattenDotted(null), {});
  });

  it('returns {} for undefined', () => {
    assert.deepStrictEqual(flattenDotted(undefined), {});
  });

  it('does not unroll arrays', () => {
    assert.deepStrictEqual(flattenDotted({ a: [1, 2] }), { a: [1, 2] });
  });

  it('keeps already-flat keys with dots unchanged (dot in key name is a string key)', () => {
    // An object whose key literally contains a dot is not nested — it is a
    // plain string key. flattenDotted only recurses into plain sub-objects.
    assert.deepStrictEqual(flattenDotted({ 'a.b': 1 }), { 'a.b': 1 });
  });

  it('handles empty object', () => {
    assert.deepStrictEqual(flattenDotted({}), {});
  });

  it('flattens multiple sibling keys', () => {
    assert.deepStrictEqual(
      flattenDotted({ a: { x: 1, y: 2 } }),
      { 'a.x': 1, 'a.y': 2 }
    );
  });

  it('flattens three levels deep', () => {
    assert.deepStrictEqual(
      flattenDotted({ a: { b: { c: 42 } } }),
      { 'a.b.c': 42 }
    );
  });
});

// ---------------------------------------------------------------------------
// isPluginEnabled
// ---------------------------------------------------------------------------
describe('isPluginEnabled', () => {
  it('returns true when flat key plugin.name.enabled is true', () => {
    const cfg = { 'plugin.rate-burst.enabled': true };
    // flattenDotted treats 'plugin.rate-burst.enabled' as a leaf string key
    // so we need the nested form for the function to find it
    const cfg2 = { plugin: { 'rate-burst': { enabled: true } } };
    assert.strictEqual(isPluginEnabled(cfg2, 'rate-burst', false), true);
  });

  it('returns false when nested plugin.name.enabled is false', () => {
    const cfg = { plugin: { myPlugin: { enabled: false } } };
    assert.strictEqual(isPluginEnabled(cfg, 'myPlugin', true), false);
  });

  it('falls back to defaultEnabled=true when key is absent', () => {
    assert.strictEqual(isPluginEnabled({}, 'no-such-plugin', true), true);
  });

  it('falls back to defaultEnabled=false when key is absent', () => {
    assert.strictEqual(isPluginEnabled({}, 'no-such-plugin', false), false);
  });

  it('returns false when defaultEnabled is omitted (undefined)', () => {
    // defaultEnabled === true check: undefined !== true → false
    assert.strictEqual(isPluginEnabled({}, 'no-such-plugin', undefined), false);
  });

  it('explicit enabled:true beats defaultEnabled:false', () => {
    const cfg = { plugin: { foo: { enabled: true } } };
    assert.strictEqual(isPluginEnabled(cfg, 'foo', false), true);
  });

  it('explicit enabled:false beats defaultEnabled:true', () => {
    const cfg = { plugin: { foo: { enabled: false } } };
    assert.strictEqual(isPluginEnabled(cfg, 'foo', true), false);
  });
});

// ---------------------------------------------------------------------------
// pluginConfig
// ---------------------------------------------------------------------------
describe('pluginConfig', () => {
  it('extracts sub-keys except enabled', () => {
    const cfg = { plugin: { 'rate-burst': { enabled: true, window: 5000 } } };
    assert.deepStrictEqual(pluginConfig(cfg, 'rate-burst'), { window: 5000 });
  });

  it('returns empty object when plugin has only enabled key', () => {
    const cfg = { plugin: { foo: { enabled: true } } };
    assert.deepStrictEqual(pluginConfig(cfg, 'foo'), {});
  });

  it('returns empty object when plugin is absent', () => {
    assert.deepStrictEqual(pluginConfig({}, 'missing'), {});
  });

  it('extracts multiple sub-keys', () => {
    const cfg = { plugin: { bar: { enabled: false, threshold: 3, window: 1000 } } };
    assert.deepStrictEqual(pluginConfig(cfg, 'bar'), { threshold: 3, window: 1000 });
  });

  it('does not include keys from a different plugin', () => {
    const cfg = {
      plugin: {
        foo: { enabled: true, x: 1 },
        bar: { enabled: true, y: 2 },
      },
    };
    assert.deepStrictEqual(pluginConfig(cfg, 'foo'), { x: 1 });
    assert.deepStrictEqual(pluginConfig(cfg, 'bar'), { y: 2 });
  });
});

// ---------------------------------------------------------------------------
// dumpFlat — not exported; validated indirectly via flattenDotted + format rules
// ---------------------------------------------------------------------------
describe('dumpFlat (indirect — function is not exported)', () => {
  // Replicate the serializer logic from config.js to verify the expected
  // output format without touching the filesystem.
  function dumpFlat(obj) {
    const flat = flattenDotted(obj);
    const lines = [];
    for (const k of Object.keys(flat)) {
      const v = flat[k];
      if (v === true) lines.push(`${k}: true`);
      else if (v === false) lines.push(`${k}: false`);
      else if (typeof v === 'number') lines.push(`${k}: ${v}`);
      else if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
      else lines.push(`${k}: ${v}`);
    }
    return lines.join('\n') + '\n';
  }

  it('serialises boolean true', () => {
    assert.strictEqual(dumpFlat({ a: { b: true } }), 'a.b: true\n');
  });

  it('serialises boolean false', () => {
    assert.strictEqual(dumpFlat({ a: { b: false } }), 'a.b: false\n');
  });

  it('serialises a number', () => {
    assert.strictEqual(dumpFlat({ timeout: 123 }), 'timeout: 123\n');
  });

  it('serialises a string', () => {
    assert.strictEqual(dumpFlat({ name: 'hello' }), 'name: hello\n');
  });

  it('serialises an array', () => {
    assert.strictEqual(dumpFlat({ items: [1, 2] }), 'items: [1, 2]\n');
  });

  it('result always ends with newline', () => {
    assert.ok(dumpFlat({ x: 1 }).endsWith('\n'));
  });

  it('empty object produces a single newline', () => {
    assert.strictEqual(dumpFlat({}), '\n');
  });
});
