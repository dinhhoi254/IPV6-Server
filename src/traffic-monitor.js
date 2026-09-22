'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const { db, logger } = require('./db');
const proxyManager = require('./proxy-manager');

const TABLE = 'proxyacct';
const CHAINS = ['input', 'output'];

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: opts.encoding || 'utf8', stdio: 'pipe', timeout: opts.timeout || 10000 });
}

function chainExists(chain) {
  try {
    run(`nft list chain ip6 ${TABLE} ${chain}`);
    return true;
  } catch (_) {
    return false;
  }
}

function initNftables() {
  if (process.env.DRY_RUN === '1') {
    logger.info('[DRY_RUN] skip nftables init');
    return;
  }
  try {
    try { run(`nft add table ip6 ${TABLE}`); } catch (_) {}
    if (!chainExists('output')) {
      try { run(`nft add chain ip6 ${TABLE} output { type filter hook output priority 0 \\; }`); } catch (_) {}
    }
    if (!chainExists('input')) {
      try { run(`nft add chain ip6 ${TABLE} input { type filter hook input priority 0 \\; }`); } catch (_) {}
    }
    logger.info('nftables proxyacct initialized');
  } catch (e) {
    logger.warn({ err: e.message }, 'nftables init failed');
  }
}

function listChain(chain) {
  try {
    return run(`nft --handle -nn list chain ip6 ${TABLE} ${chain}`);
  } catch (_) {
    return '';
  }
}

function hasRule(chain, ipv6, direction) {
  const out = listChain(chain);
  return out.split('\n').some((line) => line.includes(ipv6) && line.includes(direction));
}

function addRule(chain, ipv6, expr) {
  if (hasRule(chain, ipv6, expr.includes('saddr') ? 'saddr' : 'daddr')) return;
  run(`nft add rule ip6 ${TABLE} ${chain} ${expr} ${ipv6} counter`);
}

function addCounter(ipv6) {
  if (process.env.DRY_RUN === '1') return;
  try {
    initNftables();
    addRule('output', ipv6, 'ip6 saddr');
    addRule('input', ipv6, 'ip6 daddr');
  } catch (e) {
    logger.warn({ ipv6, err: e.message }, 'addCounter failed');
  }
}

function removeCounter(ipv6) {
  if (process.env.DRY_RUN === '1') return;
  for (const chain of CHAINS) {
    try {
      const out = listChain(chain);
      for (const line of out.split('\n')) {
        if (!line.includes(ipv6)) continue;
        const m = line.match(/handle\s+(\d+)/);
        if (m) {
          try { run(`nft delete rule ip6 ${TABLE} ${chain} handle ${m[1]}`); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  try { db.prepare('DELETE FROM traffic_state WHERE ipv6=?').run(ipv6); } catch (_) {}
}

function syncCountersFromDb() {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT p.ipv6
      FROM proxies p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status='active' AND o.status='active' AND o.type != 'rotating'
    `).all();
    for (const row of rows) {
      addCounter(row.ipv6);
      try { proxyManager.ensureIpv6OnInterface(row.ipv6); } catch (_) {}
    }
    return rows.length;
  } catch (e) {
    logger.warn({ err: e.message }, 'syncCountersFromDb failed');
    return 0;
  }
}

function counterSide(rule) {
  const chain = rule.chain || '';
  if (chain === 'input') return 'in';
  if (chain === 'output') return 'out';
  return null;
}

function collectCounters() {
  let json;
  try {
    const out = run(`nft -j list table ip6 ${TABLE}`, { timeout: 10000 });
    json = JSON.parse(out);
  } catch (e) {
    logger.warn({ err: e.message }, 'nft list failed');
    return new Map();
  }

  const counters = new Map();
  try {
    const rules = json?.nftables?.filter((x) => x.rule) || [];
    for (const entry of rules) {
      const rule = entry.rule;
      const side = counterSide(rule);
      if (!side) continue;
      const exprs = rule.expr || [];
      let ipv6 = null;
      let bytes = 0;
      for (const ex of exprs) {
        const field = ex.match?.left?.payload?.field;
        if ((side === 'out' && field === 'saddr') || (side === 'in' && field === 'daddr')) ipv6 = ex.match.right;
        if (ex.counter) bytes = ex.counter.bytes || 0;
      }
      if (!ipv6) continue;
      const cur = counters.get(ipv6) || { in: 0, out: 0 };
      cur[side] += bytes || 0;
      counters.set(ipv6, cur);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Parse nft JSON failed');
  }
  return counters;
}

function seedCounterStateIfEmpty() {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM traffic_state').get().c;
    if (count > 0) return false;
    const counters = collectCounters();
    if (counters.size === 0) return false;
    const stmt = db.prepare(`
      INSERT INTO traffic_state (ipv6, bytes_in, bytes_out, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(ipv6) DO UPDATE SET
        bytes_in=excluded.bytes_in,
        bytes_out=excluded.bytes_out,
        updated_at=datetime('now')
    `);
    const tx = db.transaction(() => {
      for (const [ipv6, bytes] of counters) stmt.run(ipv6, bytes.in || 0, bytes.out || 0);
    });
    tx();
    logger.info({ seeded: counters.size }, 'Traffic counter state seeded');
    return true;
  } catch (e) {
    logger.warn({ err: e.message }, 'seedCounterStateIfEmpty failed');
    return false;
  }
}

function parseLogBytes(line) {
  const match = line.trim().match(/(?:^|\s)(\d+)\s+(\d+)\s*$/);
  if (!match) return null;
  const bytesOut = Number(match[1]);
  const bytesIn = Number(match[2]);
  if (!Number.isFinite(bytesOut) || !Number.isFinite(bytesIn)) return null;
  return { bytesIn, bytesOut };
}

function readNewLogLines(proxyId, port) {
  const logPath = proxyManager.proxyLogPath(port);
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch (_) {
    return { lines: [], offset: null };
  }
  if (!stat.isFile()) return { lines: [], offset: null };

  const state = db.prepare('SELECT offset FROM proxy_log_state WHERE proxy_id=?').get(proxyId);
  let offset = Math.max(0, Number(state?.offset || 0));
  if (offset > stat.size) offset = 0;
  if (offset === stat.size) return { lines: [], offset };

  const len = stat.size - offset;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buffer, 0, len, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    let nextOffset = offset + bytesRead;

    if (text && !text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return { lines: [], offset };
      const complete = text.slice(0, lastNl + 1);
      nextOffset = offset + Buffer.byteLength(complete);
      text = complete;
    }

    return { lines: text.split(/\r?\n/).filter(Boolean), offset: nextOffset };
  } finally {
    fs.closeSync(fd);
  }
}

function collectProxyLogs() {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT p.id, p.order_id, p.port
      FROM proxies p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status='active' AND o.status='active' AND o.type='rotating'
    `).all();
  } catch (e) {
    logger.warn({ err: e.message }, 'Proxy log query failed');
    return { updated: 0, bytes: 0 };
  }

  let updated = 0;
  let totalDelta = 0;
  const updates = [];

  for (const proxy of rows) {
    let read;
    try {
      read = readNewLogLines(proxy.id, proxy.port);
    } catch (e) {
      logger.warn({ proxyId: proxy.id, port: proxy.port, err: e.message }, 'Proxy log read failed');
      continue;
    }
    if (read.offset === null) continue;

    let bytesIn = 0;
    let bytesOut = 0;
    for (const line of read.lines) {
      const parsed = parseLogBytes(line);
      if (!parsed) continue;
      bytesIn += parsed.bytesIn;
      bytesOut += parsed.bytesOut;
    }

    updates.push({ ...proxy, offset: read.offset, bytesIn, bytesOut });
  }

  if (updates.length === 0) return { updated: 0, bytes: 0 };

  const tx = db.transaction(() => {
    const upsertState = db.prepare(`
      INSERT INTO proxy_log_state (proxy_id, offset, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(proxy_id) DO UPDATE SET
        offset=excluded.offset,
        updated_at=datetime('now')
    `);
    for (const item of updates) {
      upsertState.run(item.id, item.offset);
      const deltaTotal = item.bytesIn + item.bytesOut;
      if (deltaTotal <= 0) continue;
      db.prepare('UPDATE proxies SET bytes_in = bytes_in + ?, bytes_out = bytes_out + ? WHERE id=?').run(item.bytesIn, item.bytesOut, item.id);
      db.prepare('UPDATE orders SET traffic_used_bytes = traffic_used_bytes + ? WHERE id=?').run(deltaTotal, item.order_id);
      db.prepare('INSERT INTO traffic_log (proxy_id, bytes_in, bytes_out) VALUES (?,?,?)').run(item.id, item.bytesIn, item.bytesOut);
      updated++;
      totalDelta += deltaTotal;
    }
  });
  tx();

  if (updated > 0) logger.info({ updated, totalDelta }, 'Proxy logs synced');
  return { updated, bytes: totalDelta };
}

function collectAndUpdate() {
  const logResult = collectProxyLogs();
  if (process.env.DRY_RUN === '1') return logResult;
  const counters = collectCounters();
  if (counters.size === 0) return logResult;

  let updated = 0;
  let totalDelta = 0;
  const tx = db.transaction(() => {
    const getState = db.prepare('SELECT bytes_in, bytes_out FROM traffic_state WHERE ipv6=?');
    const upsertState = db.prepare(`
      INSERT INTO traffic_state (ipv6, bytes_in, bytes_out, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(ipv6) DO UPDATE SET
        bytes_in=excluded.bytes_in,
        bytes_out=excluded.bytes_out,
        updated_at=datetime('now')
    `);
    for (const [ipv6, bytes] of counters) {
      const state = getState.get(ipv6) || { bytes_in: 0, bytes_out: 0 };
      const deltaIn = Math.max(0, (bytes.in || 0) - (state.bytes_in || 0));
      const deltaOut = Math.max(0, (bytes.out || 0) - (state.bytes_out || 0));
      upsertState.run(ipv6, bytes.in || 0, bytes.out || 0);
      if (deltaIn <= 0 && deltaOut <= 0) continue;

      const proxy = db.prepare(`
        SELECT p.id, p.order_id
        FROM proxies p
        JOIN orders o ON o.id = p.order_id
        WHERE p.ipv6=? AND p.status='active' AND o.status='active' AND o.type != 'rotating'
      `).get(ipv6);
      if (!proxy) continue;
      const deltaTotal = deltaIn + deltaOut;
      db.prepare('UPDATE proxies SET bytes_in = bytes_in + ?, bytes_out = bytes_out + ? WHERE id=?').run(deltaIn, deltaOut, proxy.id);
      db.prepare('UPDATE orders SET traffic_used_bytes = traffic_used_bytes + ? WHERE id=?').run(deltaTotal, proxy.order_id);
      db.prepare('INSERT INTO traffic_log (proxy_id, bytes_in, bytes_out) VALUES (?,?,?)').run(proxy.id, deltaIn, deltaOut);
      updated++;
      totalDelta += deltaTotal;
    }
  });
  tx();
  if (updated > 0) logger.info({ updated, totalDelta }, 'Traffic counters synced');
  return { updated: updated + logResult.updated, bytes: totalDelta + logResult.bytes };
}

let intervalId = null;
function start(intervalMs) {
  const ms = intervalMs || 60_000;
  initNftables();
  const synced = syncCountersFromDb();
  if (synced > 0) logger.info({ synced }, 'Traffic counters synced from DB');
  seedCounterStateIfEmpty();
  intervalId = setInterval(collectAndUpdate, ms);
  logger.info({ intervalMs: ms }, 'Traffic monitor started');
}

function stop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

module.exports = {
  initNftables,
  addCounter,
  removeCounter,
  syncCountersFromDb,
  collectProxyLogs,
  collectAndUpdate,
  seedCounterStateIfEmpty,
  start,
  stop,
};
