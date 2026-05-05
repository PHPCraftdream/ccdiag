'use strict';

const PATTERNS = [
  { name: 'anthropic_admin_key', re: /sk-ant-admin[0-9]{2}-[A-Za-z0-9_\-]{20,}/g },
  { name: 'anthropic_key',       re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: 'openai_key',          re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: 'jwt',                 re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g },
  { name: 'github_pat',          re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { name: 'github_pat_new',      re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { name: 'slack_token',         re: /\bxox[abprso]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws_access_key_id',   re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key',      re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: 'bearer',              re: /(\b[Bb]earer\s+)([A-Za-z0-9._\-+/=]{16,})/g, captureValueGroup: 2 },
  { name: 'basic',               re: /(\b[Bb]asic\s+)([A-Za-z0-9+/=]{16,})/g, captureValueGroup: 2 },
];

const KV_RE = /([\w.-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|pwd|api_key|api-key)[\w.-]*)(['"]?\s*[:=]\s*['"]?)([^\s'"&,;}\]]{6,})(['"]?)/gi;

const SENSITIVE_HEADER_VALUES = new Set([
  'authorization',
  'x-api-key',
  'x-anthropic-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
]);

const SENSITIVE_ENV_RE = /^(?:.*_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|.*_PASSWD|.*_PWD|ANTHROPIC_AUTH_TOKEN|AWS_SESSION_TOKEN|OPENAI_API_KEY)$/i;
const ENV_NAME_DENYLIST = new Set([
  'PATH', 'PATHEXT', 'PWD', 'OLDPWD', 'PS1', 'TERM',
  'HOME', 'USER', 'USERNAME', 'LANG', 'LC_ALL',
  'NODE_OPTIONS', 'NODE_PATH',
]);

function placeholder(name) {
  return `[${name}]`;
}

function buildEnvValueList(env) {
  const out = [];
  for (const k of Object.keys(env)) {
    if (ENV_NAME_DENYLIST.has(k)) continue;
    if (!SENSITIVE_ENV_RE.test(k)) continue;
    const v = env[k];
    if (!v || typeof v !== 'string') continue;
    if (v.length < 8) continue;
    out.push({ name: k, value: v });
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

function makeScrubber(env) {
  const envValues = buildEnvValueList(env || process.env);

  return function scrub(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;

    for (const ev of envValues) {
      if (out.indexOf(ev.value) !== -1) {
        out = out.split(ev.value).join(placeholder(ev.name));
      }
    }

    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.captureValueGroup) {
        out = out.replace(p.re, (_m, prefix) => prefix + placeholder(p.name));
      } else {
        out = out.replace(p.re, placeholder(p.name));
      }
    }

    KV_RE.lastIndex = 0;
    out = out.replace(KV_RE, (_m, key, sep, _val, quote) => `${key}${sep}${placeholder(key)}${quote}`);

    return out;
  };
}

function redactObject(obj, scrub, depth) {
  if (depth == null) depth = 0;
  if (depth > 50) return '[deep]';
  if (obj == null) return obj;
  const t = typeof obj;
  if (t === 'string') return scrub(obj);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return obj;
  if (Array.isArray(obj)) {
    const arr = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) arr[i] = redactObject(obj[i], scrub, depth + 1);
    return arr;
  }
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      const kl = k.toLowerCase();
      if (SENSITIVE_HEADER_VALUES.has(kl)) {
        out[k] = placeholder(kl);
      } else {
        out[k] = redactObject(obj[k], scrub, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

module.exports = { makeScrubber, redactObject, PATTERNS, SENSITIVE_ENV_RE, SENSITIVE_HEADER_VALUES };
