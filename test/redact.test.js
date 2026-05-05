'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  makeScrubber,
  redactObject,
  PATTERNS,
  SENSITIVE_ENV_RE,
  SENSITIVE_HEADER_VALUES,
} = require('../src/redact.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scrub(s) {
  return makeScrubber({})(s);
}

// ---------------------------------------------------------------------------
// PATTERNS export sanity
// ---------------------------------------------------------------------------

describe('PATTERNS export', () => {
  it('is a non-empty array of objects with name and re', () => {
    assert.ok(Array.isArray(PATTERNS));
    assert.ok(PATTERNS.length > 0);
    for (const p of PATTERNS) {
      assert.ok(typeof p.name === 'string');
      assert.ok(p.re instanceof RegExp);
    }
  });
});

// ---------------------------------------------------------------------------
// SENSITIVE_ENV_RE
// ---------------------------------------------------------------------------

describe('SENSITIVE_ENV_RE', () => {
  it('matches typical sensitive env var names', () => {
    const matches = [
      'ANTHROPIC_API_KEY', 'MY_SECRET', 'DB_PASSWORD', 'AUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'AWS_SESSION_TOKEN', 'FOO_PASSWD', 'BAR_PWD',
    ];
    for (const name of matches) {
      assert.ok(SENSITIVE_ENV_RE.test(name), `expected SENSITIVE_ENV_RE to match ${name}`);
    }
  });

  it('does not match innocuous env var names', () => {
    const noMatch = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'NODE_PATH', 'DISPLAY'];
    for (const name of noMatch) {
      // Reset lastIndex in case the regex is stateful
      SENSITIVE_ENV_RE.lastIndex = 0;
      assert.ok(!SENSITIVE_ENV_RE.test(name), `expected SENSITIVE_ENV_RE NOT to match ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// SENSITIVE_HEADER_VALUES
// ---------------------------------------------------------------------------

describe('SENSITIVE_HEADER_VALUES', () => {
  it('contains expected header names', () => {
    const expected = [
      'authorization', 'x-api-key', 'x-anthropic-api-key',
      'cookie', 'set-cookie', 'proxy-authorization',
      'x-auth-token', 'x-access-token', 'x-csrf-token',
    ];
    for (const h of expected) {
      assert.ok(SENSITIVE_HEADER_VALUES.has(h), `expected Set to contain ${h}`);
    }
  });
});

// ---------------------------------------------------------------------------
// makeScrubber — API key patterns
// ---------------------------------------------------------------------------

describe('makeScrubber — Anthropic key', () => {
  it('redacts sk-ant-* key', () => {
    const result = scrub('key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678');
    assert.ok(!result.includes('sk-ant-'));
    assert.ok(result.includes('[anthropic_key]') || result.includes('[anthropic_admin_key]'));
  });

  it('redacts sk-ant-admin* key', () => {
    const result = scrub('admin key: sk-ant-admin01-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    assert.ok(!result.includes('sk-ant-admin'));
    assert.ok(result.includes('[anthropic_admin_key]'));
  });
});

describe('makeScrubber — OpenAI key', () => {
  it('redacts sk-* openai key', () => {
    const key = 'sk-' + 'A'.repeat(48);
    const result = scrub(`Authorization: Bearer ${key}`);
    assert.ok(!result.includes(key));
  });

  it('replaces standalone openai key with [openai_key]', () => {
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345';
    const result = scrub(key);
    assert.ok(result.includes('[openai_key]'), `got: ${result}`);
  });
});

describe('makeScrubber — JWT', () => {
  it('redacts a standard JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scrub(`token=${jwt}`);
    assert.ok(!result.includes('eyJhbGci'));
    assert.ok(result.includes('[jwt]'), `got: ${result}`);
  });
});

describe('makeScrubber — GitHub PAT', () => {
  it('redacts ghp_ token', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const result = scrub(`GITHUB_TOKEN=${token}`);
    assert.ok(!result.includes(token));
    assert.ok(result.includes('[github_pat]'), `got: ${result}`);
  });

  it('redacts gho_ token', () => {
    const token = 'gho_' + 'B'.repeat(36);
    const result = scrub(token);
    assert.ok(result.includes('[github_pat]'), `got: ${result}`);
  });

  it('redacts ghu_ token', () => {
    const token = 'ghu_' + 'C'.repeat(36);
    const result = scrub(token);
    assert.ok(result.includes('[github_pat]'), `got: ${result}`);
  });

  it('redacts ghs_ token', () => {
    const token = 'ghs_' + 'D'.repeat(36);
    const result = scrub(token);
    assert.ok(result.includes('[github_pat]'), `got: ${result}`);
  });

  it('redacts ghr_ token', () => {
    const token = 'ghr_' + 'E'.repeat(36);
    const result = scrub(token);
    assert.ok(result.includes('[github_pat]'), `got: ${result}`);
  });

  it('redacts github_pat_ fine-grained token', () => {
    const token = 'github_pat_' + 'F'.repeat(66);
    const result = scrub(token);
    assert.ok(result.includes('[github_pat_new]'), `got: ${result}`);
  });
});

describe('makeScrubber — Slack token', () => {
  it('redacts xoxb- bot token', () => {
    const token = 'xoxb-FAKE00000000-FAKE000000000-FAKEfghijklmnopqrstuvwx';
    const result = scrub(`slack_token=${token}`);
    assert.ok(!result.includes('xoxb-'));
    assert.ok(result.includes('[slack_token]'), `got: ${result}`);
  });

  it('redacts xoxp- user token', () => {
    const token = 'xoxp-FAKE11111111-FAKE22222222-FAKEfghijklmnopqrstuvwx';
    const result = scrub(token);
    assert.ok(result.includes('[slack_token]'), `got: ${result}`);
  });
});

describe('makeScrubber — AWS access key', () => {
  it('redacts AKIA* key', () => {
    const key = 'AKIA' + 'A'.repeat(16);
    const result = scrub(`aws_access_key_id=${key}`);
    assert.ok(!result.includes('AKIA'));
    assert.ok(result.includes('[aws_access_key_id]'), `got: ${result}`);
  });
});

describe('makeScrubber — Google API key', () => {
  it('redacts AIza* key', () => {
    const key = 'AIza' + 'A'.repeat(35);
    const result = scrub(`key=${key}`);
    assert.ok(!result.includes('AIza'));
    assert.ok(result.includes('[google_api_key]'), `got: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Bearer / Basic with capture group
// ---------------------------------------------------------------------------

describe('makeScrubber — Bearer token', () => {
  it('keeps "Bearer " prefix and redacts value', () => {
    const result = scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    assert.ok(result.includes('Bearer '), `"Bearer " prefix should be kept, got: ${result}`);
    assert.ok(result.includes('[bearer]'), `got: ${result}`);
    assert.ok(!result.includes('abcdefghijk'));
  });

  it('handles lowercase "bearer"', () => {
    const result = scrub('bearer abcdefghijklmnopqrstuvwxyz0123456789');
    assert.ok(result.toLowerCase().includes('bearer '));
    assert.ok(result.includes('[bearer]'), `got: ${result}`);
  });
});

describe('makeScrubber — Basic token', () => {
  it('keeps "Basic " prefix and redacts base64 credential', () => {
    const cred = Buffer.from('user:password123').toString('base64');
    const result = scrub(`Authorization: Basic ${cred}`);
    assert.ok(result.includes('Basic '), `"Basic " prefix should be kept, got: ${result}`);
    assert.ok(result.includes('[basic]'), `got: ${result}`);
    assert.ok(!result.includes(cred));
  });
});

// ---------------------------------------------------------------------------
// Key-value pairs
// ---------------------------------------------------------------------------

describe('makeScrubber — key=value pairs', () => {
  it('redacts api_key=value', () => {
    const result = scrub('api_key=supersecret123456');
    assert.ok(!result.includes('supersecret'));
    assert.ok(result.includes('[api_key]'), `got: ${result}`);
  });

  it('redacts password:value', () => {
    const result = scrub('password: mypassword999');
    assert.ok(!result.includes('mypassword'));
    assert.ok(result.includes('[password]'), `got: ${result}`);
  });

  it('redacts secret=value', () => {
    const result = scrub('client_secret=abc123xyzABCDEFGH');
    assert.ok(!result.includes('abc123xyz'));
    assert.ok(result.includes('[client_secret]'), `got: ${result}`);
  });

  it('redacts access_token=value', () => {
    const result = scrub('access_token=tok_ABCDEFGH12345678901234567890');
    assert.ok(!result.includes('tok_ABCDEFGH'));
  });

  it('redacts auth_token in JSON-like string', () => {
    const result = scrub('{"auth_token":"verysecrettoken1234"}');
    assert.ok(!result.includes('verysecrettoken'));
  });
});

// ---------------------------------------------------------------------------
// Env value substitution
// ---------------------------------------------------------------------------

describe('makeScrubber — env values', () => {
  it('replaces known sensitive env value with [ENV_NAME] placeholder', () => {
    const env = { MY_SECRET_KEY: 'supersensitive9999' };
    const scrubFn = makeScrubber(env);
    const result = scrubFn('the secret is supersensitive9999 here');
    assert.ok(!result.includes('supersensitive9999'), `got: ${result}`);
    assert.ok(result.includes('[MY_SECRET_KEY]'), `got: ${result}`);
  });

  it('ignores env values shorter than 8 chars', () => {
    const env = { MY_SECRET_KEY: 'short' };
    const scrubFn = makeScrubber(env);
    const result = scrubFn('value: short something else');
    assert.ok(result.includes('short'), `short values should not be replaced, got: ${result}`);
  });

  it('ignores env vars not matching SENSITIVE_ENV_RE', () => {
    const env = { USERNAME: 'johnsmith_long_value' };
    const scrubFn = makeScrubber(env);
    const result = scrubFn('user is johnsmith_long_value here');
    // USERNAME is in the denylist, so value should NOT be replaced
    assert.ok(result.includes('johnsmith_long_value'), `denylist var should not be redacted, got: ${result}`);
  });

  it('scrubs multiple env values', () => {
    const env = {
      API_KEY: 'firstsecretvalue',
      ANOTHER_TOKEN: 'secondsecretvalue99',
    };
    const scrubFn = makeScrubber(env);
    const result = scrubFn('a=firstsecretvalue b=secondsecretvalue99');
    assert.ok(!result.includes('firstsecretvalue'), `got: ${result}`);
    assert.ok(!result.includes('secondsecretvalue'), `got: ${result}`);
    assert.ok(result.includes('[API_KEY]'), `got: ${result}`);
    assert.ok(result.includes('[ANOTHER_TOKEN]'), `got: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Edge cases for scrub
// ---------------------------------------------------------------------------

describe('makeScrubber — edge cases', () => {
  it('returns empty string unchanged', () => {
    assert.strictEqual(scrub(''), '');
  });

  it('returns plain string with no secrets unchanged', () => {
    const s = 'hello world 12345';
    assert.strictEqual(scrub(s), s);
  });

  it('returns non-string values as-is', () => {
    const scrubFn = makeScrubber({});
    assert.strictEqual(scrubFn(null), null);
    assert.strictEqual(scrubFn(42), 42);
    assert.strictEqual(scrubFn(true), true);
    assert.strictEqual(scrubFn(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// redactObject
// ---------------------------------------------------------------------------

describe('redactObject — primitives', () => {
  const scrubFn = makeScrubber({});

  it('returns null as-is', () => {
    assert.strictEqual(redactObject(null, scrubFn), null);
  });

  it('returns number as-is', () => {
    assert.strictEqual(redactObject(42, scrubFn), 42);
  });

  it('returns boolean as-is', () => {
    assert.strictEqual(redactObject(false, scrubFn), false);
  });

  it('scrubs string values', () => {
    const key = 'AKIA' + 'A'.repeat(16);
    const result = redactObject(key, scrubFn);
    assert.ok(result.includes('[aws_access_key_id]'), `got: ${result}`);
  });
});

describe('redactObject — arrays', () => {
  const scrubFn = makeScrubber({});

  it('recurses into arrays', () => {
    const arr = ['hello', 'AKIA' + 'B'.repeat(16), 42];
    const result = redactObject(arr, scrubFn);
    assert.strictEqual(result[0], 'hello');
    assert.ok(result[1].includes('[aws_access_key_id]'));
    assert.strictEqual(result[2], 42);
  });

  it('handles nested arrays', () => {
    const arr = [['AKIA' + 'C'.repeat(16)]];
    const result = redactObject(arr, scrubFn);
    assert.ok(result[0][0].includes('[aws_access_key_id]'));
  });
});

describe('redactObject — plain objects', () => {
  const scrubFn = makeScrubber({});

  it('scrubs string values in objects', () => {
    const obj = { message: 'key=sk-ant-abc123-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
    const result = redactObject(obj, scrubFn);
    assert.ok(!result.message.includes('sk-ant-'));
  });

  it('passes through numbers and booleans in objects', () => {
    const obj = { count: 5, active: true };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result.count, 5);
    assert.strictEqual(result.active, true);
  });

  it('recurses into nested objects', () => {
    const obj = { outer: { inner: 'AKIA' + 'D'.repeat(16) } };
    const result = redactObject(obj, scrubFn);
    assert.ok(result.outer.inner.includes('[aws_access_key_id]'));
  });
});

describe('redactObject — sensitive headers', () => {
  const scrubFn = makeScrubber({});

  it('replaces authorization header value entirely', () => {
    const obj = { authorization: 'Bearer some-token-here' };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result.authorization, '[authorization]');
  });

  it('replaces x-api-key header value entirely', () => {
    const obj = { 'x-api-key': 'sk-ant-api03-realkey12345678901234567890' };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result['x-api-key'], '[x-api-key]');
  });

  it('replaces x-anthropic-api-key header value entirely', () => {
    const obj = { 'x-anthropic-api-key': 'sk-ant-realkey12345678901234567890' };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result['x-anthropic-api-key'], '[x-anthropic-api-key]');
  });

  it('replaces cookie header value entirely', () => {
    const obj = { cookie: 'session=abc123; token=xyz' };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result.cookie, '[cookie]');
  });

  it('handles mixed sensitive and non-sensitive headers', () => {
    const obj = {
      'content-type': 'application/json',
      authorization: 'Bearer token123',
      'x-request-id': 'req-456',
    };
    const result = redactObject(obj, scrubFn);
    assert.strictEqual(result['content-type'], 'application/json');
    assert.strictEqual(result.authorization, '[authorization]');
    assert.strictEqual(result['x-request-id'], 'req-456');
  });
});

describe('redactObject — depth limit', () => {
  const scrubFn = makeScrubber({});

  it('returns "[deep]" when depth exceeds 50', () => {
    // Build a deeply nested object 52 levels deep
    let obj = { val: 'leaf' };
    for (let i = 0; i < 52; i++) obj = { nested: obj };
    const result = redactObject(obj, scrubFn);
    // At some nesting level the result collapses to '[deep]'
    // Walk down until we hit it
    let cur = result;
    let hitDeep = false;
    for (let i = 0; i < 60; i++) {
      if (cur === '[deep]') { hitDeep = true; break; }
      if (cur && typeof cur === 'object') cur = cur.nested;
      else break;
    }
    assert.ok(hitDeep, 'Expected [deep] marker for deeply nested object');
  });

  it('does not truncate at depth <= 50', () => {
    let obj = { val: 'leaf' };
    for (let i = 0; i < 49; i++) obj = { nested: obj };
    const result = redactObject(obj, scrubFn);
    assert.notStrictEqual(result, '[deep]');
  });
});
