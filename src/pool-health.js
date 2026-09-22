'use strict';

const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { db, logger } = require('./db');
const proxyManager = require('./proxy-manager');

const ENABLED = process.env.ROTATING_HEALTH_ENABLED !== '0';
const CHILD_PORT_START = Math.max(1024, parseInt(process.env.ROTATING_POOL_CHILD_PORT_START || '45000', 10) || 45000);
const POOL_SIZE = Math.max(1, parseInt(process.env.ROTATING_POOL_SIZE || '5000', 10) || 5000);
const CONCURRENCY = Math.max(1, parseInt(process.env.ROTATING_HEALTH_CONCURRENCY || '50', 10) || 50);
const PROBE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.ROTATING_HEALTH_TIMEOUT_MS || '5000', 10) || 5000);
const MAX_LATENCY_MS = Math.max(100, parseInt(process.env.ROTATING_HEALTH_MAX_LATENCY_MS || '1200', 10) || 1200);
const TARGET_URL = process.env.ROTATING_HEALTH_URL || 'https://www.cloudflare.com/cdn-cgi/trace';
const INTERVAL_MS = Math.max(60_000, parseInt(process.env.ROTATING_HEALTH_INTERVAL_MS || '900000', 10) || 900000);

let timer = null;
let running = false;

function childPort(index) {
  return CHILD_PORT_START + index;
}

function probeChild(port) {
  const target = new URL(TARGET_URL);
  const targetPort = Number(target.port || 443);
  const targetPath = `${target.pathname || '/'}${target.search || ''}`;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timerId = null;
    let socket = null;
    let tlsSocket = null;
    let proxyHeader = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timerId) clearTimeout(timerId);
      try { tlsSocket?.destroy(); } catch (_) {}
      try { socket?.destroy(); } catch (_) {}
      resolve({
        ok: Boolean(result.ok),
        latencyMs: Date.now() - startedAt,
        reason: result.reason || null,
      });
    };

    const fail = (reason) => finish({ ok: false, reason });
    const onTimeout = () => fail('timeout');
    const onError = () => fail('socket_error');

    timerId = setTimeout(() => fail('timeout'), PROBE_TIMEOUT_MS);
    socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(PROBE_TIMEOUT_MS, onTimeout);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${target.hostname}:${targetPort}\r\n` +
        'Proxy-Connection: Keep-Alive\r\n' +
        'Connection: Keep-Alive\r\n\r\n',
      );
    });

    const onProxyData = (chunk) => {
      proxyHeader += chunk.toString('latin1');
      if (proxyHeader.length > 8192) return fail('proxy_header_too_large');
      const headerEnd = proxyHeader.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const statusLine = proxyHeader.slice(0, headerEnd).split(/\r?\n/, 1)[0] || '';
      socket.removeListener('data', onProxyData);
      socket.removeListener('timeout', onTimeout);
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) return fail('proxy_connect_failed');

      try {
        tlsSocket = tls.connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: false,
        });
        tlsSocket.setTimeout(PROBE_TIMEOUT_MS, onTimeout);
        tlsSocket.once('error', onError);
        tlsSocket.once('secureConnect', () => {
          tlsSocket.write(
            `GET ${targetPath} HTTP/1.1\r\n` +
            `Host: ${target.hostname}\r\n` +
            'Accept: */*\r\n' +
            'Connection: close\r\n\r\n',
          );
        });
        let responseHeader = '';
        tlsSocket.on('data', (data) => {
          responseHeader += data.toString('latin1');
          if (responseHeader.includes('\r\n\r\n')) finish({ ok: true });
        });
        tlsSocket.once('close', () => {
          if (!settled) fail('closed_before_response');
        });
      } catch (_) {
        fail('tls_error');
      }
    };
    socket.on('data', onProxyData);
  });
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function healthRows() {
  return db.prepare(`
    SELECT id, ipv6
    FROM ipv6_pool
    WHERE status='rot_pool' AND COALESCE(health_status, 'unknown') != 'bad'
    ORDER BY
      CASE COALESCE(health_status, 'unknown')
        WHEN 'healthy' THEN 0
        WHEN 'unknown' THEN 1
        WHEN 'suspect' THEN 2
        ELSE 3
      END,
      CASE WHEN health_latency_ms IS NULL THEN 1 ELSE 0 END,
      health_latency_ms,
      id
    LIMIT ?
  `).all(POOL_SIZE);
}

function updateHealth(rows, results) {
  const available = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ipv6_pool
    WHERE status='available' AND COALESCE(health_status, 'unknown') != 'bad'
  `).get().c;
  const failed = rows
    .map((row, index) => ({ row, result: results[index] }))
    .filter((item) => !item.result.ok || item.result.latencyMs > MAX_LATENCY_MS)
    .sort((a, b) => {
      const aScore = a.result.ok ? a.result.latencyMs : PROBE_TIMEOUT_MS + 1;
      const bScore = b.result.ok ? b.result.latencyMs : PROBE_TIMEOUT_MS + 1;
      return bScore - aScore;
    });
  const removable = Math.min(failed.length, Math.max(0, Number(available) || 0));
  const badIds = new Set(failed.slice(0, removable).map((item) => item.row.id));

  const goodStmt = db.prepare(`
    UPDATE ipv6_pool
    SET health_status='healthy',
        health_latency_ms=?,
        health_checked_at=datetime('now'),
        health_fail_count=0
    WHERE id=? AND status='rot_pool'
  `);
  const badStmt = db.prepare(`
    UPDATE ipv6_pool
    SET status='unhealthy',
        health_status='bad',
        health_latency_ms=?,
        health_checked_at=datetime('now'),
        health_fail_count=COALESCE(health_fail_count, 0) + 1,
        assigned_order_id=NULL,
        cooldown_until=NULL
    WHERE id=? AND status='rot_pool'
  `);
  const suspectStmt = db.prepare(`
    UPDATE ipv6_pool
    SET health_status='suspect',
        health_latency_ms=?,
        health_checked_at=datetime('now'),
        health_fail_count=COALESCE(health_fail_count, 0) + 1
    WHERE id=? AND status='rot_pool'
  `);

  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      const result = results[index];
      const failedResult = !result.ok || result.latencyMs > MAX_LATENCY_MS;
      if (badIds.has(row.id)) badStmt.run(result.latencyMs, row.id);
      else if (failedResult) suspectStmt.run(result.latencyMs, row.id);
      else goodStmt.run(result.latencyMs, row.id);
    });
  });
  tx();
  return {
    checked: rows.length,
    healthy: rows.length - failed.length,
    failed: failed.length,
    removed: badIds.size,
    suspect: failed.length - badIds.size,
    available,
  };
}

async function runOnce() {
  if (!ENABLED || running) return { skipped: true };
  const rows = healthRows();
  if (rows.length === 0) return { checked: 0, failed: 0, removed: 0 };

  running = true;
  const startedAt = Date.now();
  try {
    const results = await mapConcurrent(rows, CONCURRENCY, (row, index) => probeChild(childPort(index)));
    const summary = updateHealth(rows, results);
    if (summary.removed > 0) {
      try {
        proxyManager.ensureSharedRotatingPool(POOL_SIZE);
      } catch (e) {
        logger.error({ err: e.message }, 'Rotating pool rebuild after health check failed');
      }
    }
    logger.info({
      ...summary,
      maxLatencyMs: MAX_LATENCY_MS,
      durationMs: Date.now() - startedAt,
    }, 'Rotating pool health check completed');
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  if (!ENABLED || timer) return;
  const initialDelay = Math.max(10_000, parseInt(process.env.ROTATING_HEALTH_INITIAL_DELAY_MS || '30000', 10) || 30000);
  const initialTimer = setTimeout(() => {
    runOnce().catch((e) => logger.error({ err: e.message }, 'Rotating pool health check failed'));
  }, initialDelay);
  initialTimer.unref();
  timer = setInterval(() => {
    runOnce().catch((e) => logger.error({ err: e.message }, 'Rotating pool health check failed'));
  }, INTERVAL_MS);
  timer.unref();
  logger.info({
    initialDelay,
    intervalMs: INTERVAL_MS,
    concurrency: CONCURRENCY,
    maxLatencyMs: MAX_LATENCY_MS,
    targetUrl: TARGET_URL,
  }, 'Rotating pool health monitor started');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, start, stop, probeChild };
