'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { randomUUID, createHash } = require('crypto');

function bodyCap() {
  const n = parseInt(process.env.CCDIAG_BODY_LIMIT, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1048576;
}

function tryDecompress(buf, encoding) {
  if (!buf || !buf.length) return { buf, used: null };
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip')    return { buf: zlib.gunzipSync(buf),         used: 'gzip' };
    if (enc === 'deflate') return { buf: zlib.inflateSync(buf),        used: 'deflate' };
    if (enc === 'br')      return { buf: zlib.brotliDecompressSync(buf), used: 'br' };
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
      return { buf: zlib.zstdDecompressSync(buf), used: 'zstd' };
    }
  } catch (e) {
    return { buf: null, used: enc, error: e.message };
  }
  return { buf, used: null };
}

function recompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip')    return zlib.gzipSync(buf);
    if (enc === 'deflate') return zlib.deflateSync(buf);
    if (enc === 'br')      return zlib.brotliCompressSync(buf);
    if (enc === 'zstd' && typeof zlib.zstdCompressSync === 'function') {
      return zlib.zstdCompressSync(buf);
    }
  } catch (_) {}
  return buf;
}

function totalBytes(arr) {
  let s = 0;
  for (const b of arr) s += b.length;
  return s;
}

function hashBuf(buf) {
  if (!buf || !buf.length) return undefined;
  return 'sha256:' + createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function pickRatelimit(h) {
  const out = {};
  if (!h) return out;
  for (const k of Object.keys(h)) {
    const kl = k.toLowerCase();
    if (kl.startsWith('anthropic-ratelimit-')) out[kl.slice(20)] = h[k];
    else if (kl === 'retry-after') out['retry_after'] = h[k];
  }
  return out;
}

function pickRequestId(h) {
  if (!h) return undefined;
  return h['request-id'] || h['x-request-id'];
}

function isTextCt(ct) {
  if (!ct) return false;
  const l = String(ct).toLowerCase();
  return l.startsWith('text/')
    || l.includes('json')
    || l.includes('xml')
    || l.includes('javascript')
    || l.includes('event-stream')
    || l.includes('form-urlencoded')
    || l.includes('graphql');
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const sample = Math.min(buf.length, 1024);
  let np = 0;
  for (let i = 0; i < sample; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32) || c === 127) np++;
  }
  return np > sample * 0.05;
}

function decodeBody(buf, ct, headers) {
  if (!buf || !buf.length) return undefined;
  const cap = bodyCap();
  const enc = headers
    ? String(headers['content-encoding'] || headers['Content-Encoding'] || '').toLowerCase()
    : '';

  let working = buf;
  let decompressedFrom = null;
  if (enc && enc !== 'identity') {
    const r = tryDecompress(buf, enc);
    if (r.error) {
      return { compressed: enc, bytes: buf.length, decompress_error: r.error };
    }
    if (r.used) {
      working = r.buf;
      decompressedFrom = r.used;
    } else {
      return { compressed: enc, bytes: buf.length };
    }
  }

  if (!isTextCt(ct) || looksBinary(working)) {
    const out = { binary: true, bytes: working.length };
    if (decompressedFrom) out.was_compressed = decompressedFrom;
    return out;
  }
  const text = working.toString('utf8');
  if (cap > 0 && text.length > cap) {
    const out = { text: text.slice(0, cap), truncated: true, total_bytes: working.length };
    if (decompressedFrom) out.was_compressed = decompressedFrom;
    return out;
  }
  if (decompressedFrom) {
    return { text, was_compressed: decompressedFrom };
  }
  return text;
}

function isStreamingResponse(headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return ct.includes('event-stream');
}

class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
  }

  feed(chunk) {
    this.buffer += chunk.toString('utf8');
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop();
    for (const raw of parts) this._processRaw(raw);
  }

  flush() {
    if (this.buffer.trim()) {
      this._processRaw(this.buffer);
      this.buffer = '';
    }
  }

  _processRaw(raw) {
    let eventType = '';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (!data) return;
    let parsed = null;
    try { parsed = JSON.parse(data); } catch (_) {}
    this.onEvent({
      eventType,
      raw,
      data: parsed,
      rawData: data,
      _mutated: false,
      setData(obj) {
        this.data = obj;
        this._mutated = true;
      },
      serialize() {
        if (!this._mutated) return raw + '\n\n';
        const lines = [];
        if (this.eventType) lines.push(`event: ${this.eventType}`);
        lines.push(`data: ${JSON.stringify(this.data)}`);
        return lines.join('\n') + '\n\n';
      },
    });
  }
}

function buildUpstreamHostHeader(upstream, upstreamPort) {
  const dflt = upstream.protocol === 'https:' ? 443 : 80;
  return upstreamPort && upstreamPort !== dflt
    ? `${upstream.hostname}:${upstreamPort}`
    : upstream.hostname;
}

function startReverseProxy(bus, options) {
  const upstream = new URL(options.upstreamUrl);
  const upstreamLib = upstream.protocol === 'https:' ? https : http;
  const upstreamPort = parseInt(upstream.port || (upstream.protocol === 'https:' ? 443 : 80), 10);
  const upstreamHostHeader = buildUpstreamHostHeader(upstream, upstreamPort);
  const plugins = options.plugins || null;
  const onFindings = typeof options.onFindings === 'function' ? options.onFindings : null;
  const gateToken = options.gateToken || null;
  const gatePrefix = gateToken ? `/gate_${gateToken}` : null;

  const server = http.createServer((clientReq, clientRes) => {
    if (gatePrefix) {
      if (!clientReq.url.startsWith(gatePrefix)) {
        try { clientRes.writeHead(403); clientRes.end(); } catch (_) {}
        return;
      }
      clientReq.url = clientReq.url.slice(gatePrefix.length) || '/';
    }

    const id = randomUUID();
    const startMs = Date.now();

    const reqChunks = [];
    let reqBytes = 0;
    const REQ_BODY_CAP_BYTES = bodyCap() > 0 ? bodyCap() * 2 : Number.MAX_SAFE_INTEGER;

    clientReq.on('error', err => {
      bus.request({
        layer: 'reverse-proxy', phase: 'error', id,
        error: err.message, code: err.code,
        duration_ms: Date.now() - startMs,
      });
      try { clientRes.writeHead(400); clientRes.end(); } catch (_) {}
    });

    clientReq.on('data', d => {
      reqBytes += d.length;
      if (totalBytes(reqChunks) < REQ_BODY_CAP_BYTES) reqChunks.push(d);
    });

    clientReq.on('end', () => {
      let reqBody = Buffer.concat(reqChunks);
      const reqHeaders = Object.assign({}, clientReq.headers);
      reqHeaders.host = upstreamHostHeader;
      delete reqHeaders['proxy-connection'];

      // --- Plugin: onRequest (can mutate headers + body) ---
      if (plugins) {
        const reqCtx = {
          id,
          method: clientReq.method,
          url: upstream.origin + clientReq.url,
          host: upstream.hostname,
          path: clientReq.url,
          headers: reqHeaders,
          bodyBuffer: reqBody,
          bodyHash: hashBuf(reqBody),
          _bodyMutated: false,
          json() {
            try { return JSON.parse(this.bodyBuffer.toString('utf8')); }
            catch (_) { return null; }
          },
          setJson(obj) {
            this.bodyBuffer = Buffer.from(JSON.stringify(obj));
            this._bodyMutated = true;
          },
          setBody(buf) {
            this.bodyBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
            this._bodyMutated = true;
          },
        };
        plugins.onRequest(reqCtx);
        if (reqCtx._bodyMutated) {
          reqBody = reqCtx.bodyBuffer;
          reqBytes = reqBody.length;
          reqHeaders['content-length'] = String(reqBody.length);
        }
        Object.assign(reqHeaders, reqCtx.headers);
      }

      const reqCt = String(reqHeaders['content-type'] || '').toLowerCase();
      const reqBodyDecoded = decodeBody(reqBody, reqCt, reqHeaders);

      bus.request({
        layer: 'reverse-proxy',
        phase: 'start',
        id,
        method: clientReq.method,
        url: upstream.origin + clientReq.url,
        host: upstream.hostname,
        port: upstreamPort,
        path: clientReq.url,
        bytes_up: reqBytes,
        body_hash: hashBuf(reqBody),
        headers: reqHeaders,
        body: reqBodyDecoded,
      });

      const upstreamReq = upstreamLib.request({
        hostname: upstream.hostname,
        port: upstreamPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: reqHeaders,
      }, upstreamRes => {
        const isStream = isStreamingResponse(upstreamRes.headers);
        const respHeaders = Object.assign({}, upstreamRes.headers);
        let statusCode = upstreamRes.statusCode || 502;

        // --- Plugin: onResponseHead (can mutate status + headers) ---
        if (plugins) {
          const headCtx = {
            id,
            statusCode,
            headers: respHeaders,
            isStream,
            request: {
              method: clientReq.method,
              host: upstream.hostname,
              path: clientReq.url,
              url: upstream.origin + clientReq.url,
            },
          };
          plugins.onResponseHead(headCtx);
          statusCode = headCtx.statusCode;
        }

        try {
          clientRes.writeHead(statusCode, respHeaders);
        } catch (_) {}

        const respChunks = [];
        let respBytes = 0;
        const RESP_BODY_CAP_BYTES = bodyCap() > 0 ? bodyCap() * 4 : Number.MAX_SAFE_INTEGER;

        const useSse = isStream && plugins && plugins.wantsSse();
        const hasMutatingSse = useSse; // future: check plugins.mutatesSse()
        const sse = useSse
          ? new SseParser(sseCtx => {
              plugins.onSseEvent(sseCtx);
              if (hasMutatingSse && sseCtx._mutated) {
                const rewritten = Buffer.from(sseCtx.serialize(), 'utf8');
                try { clientRes.write(rewritten); } catch (_) {}
                return 'handled';
              }
            })
          : null;

        upstreamRes.on('data', d => {
          respBytes += d.length;
          if (totalBytes(respChunks) < RESP_BODY_CAP_BYTES) respChunks.push(d);
          if (sse) {
            let anyMutated = false;
            const chunks = [];
            const origOnEvent = sse.onEvent;
            sse.onEvent = (ctx) => {
              const result = origOnEvent(ctx);
              if (result === 'handled') {
                anyMutated = true;
              } else {
                chunks.push(Buffer.from(ctx.serialize(), 'utf8'));
              }
            };
            sse.feed(d);
            sse.onEvent = origOnEvent;
            if (anyMutated) {
              for (const chunk of chunks) {
                try { clientRes.write(chunk); } catch (_) {}
              }
            } else {
              try { clientRes.write(d); } catch (_) {}
            }
          } else {
            try { clientRes.write(d); } catch (_) {}
          }
        });

        upstreamRes.on('end', () => {
          if (sse) try { sse.flush(); } catch (_) {}

          const respBody = Buffer.concat(respChunks);
          const respCt = String(respHeaders['content-type'] || '').toLowerCase();

          // --- Plugin: onResponseBody (non-stream, can mutate) ---
          if (plugins && !isStream && respBody.length > 0) {
            const enc = String(respHeaders['content-encoding'] || '').toLowerCase();
            let plain = respBody;
            let wasCompressed = null;
            if (enc && enc !== 'identity') {
              const r = tryDecompress(respBody, enc);
              if (r.used && r.buf) { plain = r.buf; wasCompressed = r.used; }
            }

            const bodyCtx = {
              id,
              statusCode,
              headers: respHeaders,
              bodyBuffer: plain,
              wasCompressed,
              _mutated: false,
              json() {
                try { return JSON.parse(this.bodyBuffer.toString('utf8')); }
                catch (_) { return null; }
              },
              setJson(obj) {
                this.bodyBuffer = Buffer.from(JSON.stringify(obj));
                this._mutated = true;
              },
              setBody(buf) {
                this.bodyBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
                this._mutated = true;
              },
            };
            plugins.onResponseBody(bodyCtx);

            if (bodyCtx._mutated) {
              let outBuf = bodyCtx.bodyBuffer;
              if (wasCompressed) outBuf = recompress(outBuf, wasCompressed);
              clientRes.removeHeader('content-length');
              try { clientRes.write(outBuf); } catch (_) {}
              try { clientRes.end(); } catch (_) {}

              // Evaluate plugins after response mutation
              const findings = plugins.evaluate();
              if (findings.length && onFindings) onFindings(findings);

              bus.request({
                layer: 'reverse-proxy', phase: 'end', id,
                method: clientReq.method,
                url: upstream.origin + clientReq.url,
                host: upstream.hostname, port: upstreamPort,
                path: clientReq.url, status: statusCode,
                duration_ms: Date.now() - startMs,
                bytes_up: reqBytes, bytes_down: respBytes,
                body_hash: hashBuf(reqBody),
                request_body: reqBodyDecoded,
                headers: respHeaders,
                ratelimit: pickRatelimit(respHeaders),
                request_id: pickRequestId(respHeaders),
                body: decodeBody(respBody, respCt, upstreamRes.headers),
              });
              return;
            }
          }

          try { clientRes.end(); } catch (_) {}

          // Evaluate plugins
          if (plugins) {
            const findings = plugins.evaluate();
            if (findings.length && onFindings) onFindings(findings);
          }

          bus.request({
            layer: 'reverse-proxy',
            phase: 'end',
            id,
            method: clientReq.method,
            url: upstream.origin + clientReq.url,
            host: upstream.hostname,
            port: upstreamPort,
            path: clientReq.url,
            status: statusCode,
            duration_ms: Date.now() - startMs,
            bytes_up: reqBytes,
            bytes_down: respBytes,
            body_hash: hashBuf(reqBody),
            request_body: reqBodyDecoded,
            headers: respHeaders,
            ratelimit: pickRatelimit(respHeaders),
            request_id: pickRequestId(respHeaders),
            body: decodeBody(respBody, respCt, upstreamRes.headers),
          });
        });
        upstreamRes.on('error', err => {
          if (plugins) {
            const findings = plugins.evaluate();
            if (findings.length && options.onFindings) options.onFindings(findings);
          }
          bus.request({
            layer: 'reverse-proxy', phase: 'error', id,
            error: err.message, code: err.code,
            duration_ms: Date.now() - startMs,
          });
          try { clientRes.end(); } catch (_) {}
        });
      });

      upstreamReq.on('error', err => {
        bus.request({
          layer: 'reverse-proxy', phase: 'error', id,
          error: err.message, code: err.code,
          duration_ms: Date.now() - startMs,
        });
        try { clientRes.writeHead(502); clientRes.end(); } catch (_) {}
      });

      if (reqBytes > 0) upstreamReq.write(reqBody);
      upstreamReq.end();
    });
  });

  server.on('connect', (_req, socket) => {
    try { socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); } catch (_) {}
  });

  server.on('error', err => {
    bus.event('reverse_proxy.server_error', { error: err.message });
  });

  const sockets = new Set();
  server.on('connection', sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const { port } = server.address();
      bus.event('reverse_proxy.listening', {
        port,
        upstream: upstream.origin,
      });
      resolve({
        server,
        port,
        stop: () => new Promise(r => {
          if (typeof server.closeAllConnections === 'function') {
            try { server.closeAllConnections(); } catch (_) {}
          }
          for (const s of sockets) {
            try { s.destroy(); } catch (_) {}
          }
          sockets.clear();
          server.close(() => r());
          setTimeout(r, 1000).unref?.();
        }),
      });
    });
  });
}

module.exports = { startReverseProxy };
