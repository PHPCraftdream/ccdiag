#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { readRecords } = require('../src/logger');

function analyzeSession(sessionDir) {
  const reqPath = path.join(sessionDir, 'requests.json5l');
  if (!fs.existsSync(reqPath)) return null;

  const recs = readRecords(reqPath);
  const seenIds = new Set();
  const byType = {};
  let totalInvocations = 0;
  let postCount = 0;

  for (const r of recs) {
    if (r.phase === 'start' && r.method === 'POST') postCount++;
    if (r.phase !== 'start') continue;
    const txt = typeof r.body === 'string' ? r.body : (r.body && r.body.text);
    if (!txt) continue;
    let obj;
    try { obj = JSON.parse(txt); } catch (_) { continue; }
    if (!Array.isArray(obj.messages)) continue;

    for (const msg of obj.messages) {
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Agent') continue;
        if (!block.id || seenIds.has(block.id)) continue;
        seenIds.add(block.id);
        totalInvocations++;
        const t = (block.input && block.input.subagent_type) || '<unspecified>';
        byType[t] = (byType[t] || 0) + 1;
      }
    }
  }

  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')); } catch (_) {}

  return {
    sid: path.basename(sessionDir),
    started_at: meta && meta.started_at,
    argv: meta && meta.argv,
    request_count: postCount,
    agent_invocations: totalInvocations,
    by_type: byType,
  };
}

function main() {
  const root = process.argv[2] || path.join(process.cwd(), '.ccdiag-logs');
  if (!fs.existsSync(root)) {
    process.stderr.write(`Session root not found: ${root}\n`);
    process.exit(1);
  }

  const dirs = fs.readdirSync(root)
    .map(d => path.join(root, d))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });

  const results = [];
  const totals = {};
  for (const d of dirs) {
    const r = analyzeSession(d);
    if (!r) continue;
    results.push(r);
    for (const k of Object.keys(r.by_type)) totals[k] = (totals[k] || 0) + r.by_type[k];
  }

  results.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));

  console.log('=== Per-session agent invocations ===');
  for (const r of results) {
    const argv = (r.argv || []).join(' ').slice(0, 60) || '(no args)';
    const tag = r.agent_invocations > 0 ? '★' : ' ';
    console.log(`${tag} ${(r.started_at || '?').padEnd(24)} sid=${r.sid.slice(0, 8)}  POSTs=${String(r.request_count).padStart(3)}  agents=${String(r.agent_invocations).padStart(2)}  ${argv}`);
    if (r.agent_invocations > 0) {
      for (const t of Object.keys(r.by_type).sort((a, b) => r.by_type[b] - r.by_type[a])) {
        console.log(`        ${t}: ${r.by_type[t]}`);
      }
    }
  }

  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const sessionsWith = results.filter(r => r.agent_invocations > 0).length;

  console.log('');
  console.log('=== Totals ===');
  console.log(`sessions analyzed:           ${results.length}`);
  console.log(`sessions with ≥1 Agent call: ${sessionsWith}`);
  console.log(`total Agent invocations:     ${grandTotal}`);

  if (grandTotal > 0) {
    console.log('');
    console.log('by subagent_type:');
    const sorted = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    for (const t of sorted) console.log(`  ${t.padEnd(24)} ${totals[t]}`);
  }
}

main();
