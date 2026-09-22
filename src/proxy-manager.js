'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const { db, logger } = require('./db');

const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || './configs/3proxy');
const PROXY_LOG_DIR = path.resolve(process.env.PROXY_LOG_DIR || './logs/3proxy');
const TEMPLATE_PATH = path.resolve(__dirname, '../templates/3proxy.cfg.tpl');
const BIND_IP = process.env.BIND_IP || '0.0.0.0';
const DRY_RUN = process.env.DRY_RUN === '1';
const IPV6_INTERFACE = process.env.IPV6_INTERFACE || process.env.NET_IFACE || 'eth0';
const IPV6_ASSIGN_PREFIX = Math.max(1, Math.min(128, parseInt(process.env.IPV6_ASSIGN_PREFIX || '64', 10) || 64));
const MANAGE_IPV6_ADDRS = process.env.MANAGE_IPV6_ADDRS !== '0';
const MANAGE_NDP_PROXY = process.env.MANAGE_NDP_PROXY === '1';
const DEFAULT_ROTATING_POOL_SIZE = Math.max(1, parseInt(process.env.ROTATING_POOL_SIZE || '5000', 10) || 5000);
const ROTATING_POOL_GROUPS = Math.max(1, parseInt(process.env.ROTATING_POOL_GROUPS || '100', 10) || 100);
const POOL_CHILD_PORT_START = Math.max(1024, parseInt(process.env.ROTATING_POOL_CHILD_PORT_START || '45000', 10) || 45000);
const POOL_GROUP_PORT_START = Math.max(1024, parseInt(process.env.ROTATING_POOL_GROUP_PORT_START || '52000', 10) || 52000);
const POOL_INTERNAL_USER = process.env.ROTATING_POOL_INTERNAL_USER || 'pool';
const POOL_INTERNAL_PASS = process.env.ROTATING_POOL_INTERNAL_PASS || 'pool_pass';
const POOL_CHILD_PROCESS_ID = '3proxy-rotpool-child';
const POOL_GROUP_PROCESS_ID = '3proxy-rotpool-group';
const PROXY_NOFILE = Math.max(4096, parseInt(process.env.PROXY_NOFILE || '65536', 10) || 65536);
const POOL_CHILD_SHARD_SIZE = Math.max(100, parseInt(process.env.ROTATING_POOL_CHILD_SHARD_SIZE || '500', 10) || 500);
const PROXY_START_CHECK_MS = Math.max(300, parseInt(process.env.PROXY_START_CHECK_MS || '1500', 10) || 1500);
const PROXY_START_WAIT_MS = Math.max(PROXY_START_CHECK_MS, parseInt(process.env.PROXY_START_WAIT_MS || '15000', 10) || 15000);

let rotatingPoolBindingKey = '';

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function ensureProxyLogDir() {
  fs.mkdirSync(PROXY_LOG_DIR, { recursive: true });
}

function writeIfChanged(filePath, content) {
  let previous = null;
  try { previous = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (previous === content) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

function configPath(port) {
  return path.join(CONFIG_DIR, `proxy-${port}.cfg`);
}

function proxyLogPath(port) {
  return path.join(PROXY_LOG_DIR, `proxy-${port}.log`);
}

function poolChildProcessId(shardIndex) {
  return `${POOL_CHILD_PROCESS_ID}-${shardIndex}`;
}

function poolChildConfigPath(shardIndex) {
  return path.join(CONFIG_DIR, `rotating-pool-children-${shardIndex}.cfg`);
}

function poolGroupConfigPath() {
  return path.join(CONFIG_DIR, 'rotating-pool-groups.cfg');
}

function processIdFor(port) {
  return `3proxy-${port}`;
}

function pidPathFor(processId) {
  return `/var/run/${processId}.pid`;
}

function parentWeight(size) {
  return Math.max(1, Math.floor(1000 / Math.max(1, Number(size) || 1)));
}

function renderConfig({
  port,
  ipv6 = '',
  username = '',
  password = '',
  protocol = 'http',
  parentUpstreams = [],
  authMode = 'strong',
  listenIp = BIND_IP,
  pidfile = pidPathFor(processIdFor(port)),
  logPath = proxyLogPath(port),
}) {
  if (protocol === 'both') {
    const e = new Error('protocol both not supported');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }

  const tpl = loadTemplate();
  const upstreams = Array.isArray(parentUpstreams) ? parentUpstreams.filter(Boolean) : [];
  let proxyLine = protocol === 'socks5'
    ? `socks -6 -n -a -p${port} -i${listenIp}`
    : `proxy -6 -n -a -p${port} -i${listenIp}`;
  if (upstreams.length === 0 && ipv6) proxyLine += ` -e${ipv6}`;

  const extraLines = upstreams.map((upstream) => {
    let line = `parent ${upstream.weight || 1} ${upstream.type || 'http'} ${upstream.host || '127.0.0.1'} ${upstream.port}`;
    if (upstream.username) line += ` ${upstream.username} ${upstream.password || ''}`;
    return line.trim();
  }).join('\n');

  const authBlock = authMode === 'none'
    ? 'auth none\nallow *'
    : `auth strong\nusers ${username}:CL:${password}\nallow ${username}`;

  const logBlock = logPath
    ? `log ${String(logPath).replace(/\\/g, '/')}\nlogformat "L%d-%m-%Y %H:%M:%S %p %U %E %O %I"`
    : '';

  return tpl
    .replaceAll('{{DAEMON_LINE}}', 'daemon')
    .replaceAll('{{PIDFILE}}', pidfile)
    .replaceAll('{{PORT}}', String(port))
    .replaceAll('{{USER}}', username)
    .replaceAll('{{PASSWORD}}', password)
    .replaceAll('{{LOG_PATH}}', logPath ? String(logPath).replace(/\\/g, '/') : '')
    .replaceAll('{{LOG_BLOCK}}', logBlock)
    .replaceAll('{{AUTH_BLOCK}}', authBlock)
    .replaceAll('{{EXTRA_LINES}}', extraLines)
    .replaceAll('{{PROXY_LINE}}', proxyLine.trim());
}

function renderMultiProxyConfig({ processId, services, maxconn = 1000, allowUser = '*' }) {
  const lines = [
    'daemon',
    `pidfile ${pidPathFor(processId)}`,
    `maxconn ${maxconn}`,
    'nserver 1.1.1.1',
    'nserver 8.8.8.8',
    'nscache 65536',
    'timeouts 1 5 30 60 180 1800 15 60',
    'auth none',
  ];

  for (const service of services) {
    lines.push(`allow ${allowUser}`);
    if (service.parents?.length) {
      for (const parent of service.parents) {
        let line = `parent ${parent.weight} ${parent.type || 'http'} ${parent.host || '127.0.0.1'} ${parent.port}`;
        if (parent.username) line += ` ${parent.username} ${parent.password || ''}`;
        lines.push(line.trim());
      }
    }
    let proxyLine = `proxy -6 -n -a -p${service.port} -i${service.listenIp || '127.0.0.1'}`;
    if (service.ipv6) proxyLine += ` -e${service.ipv6}`;
    lines.push(proxyLine);
    lines.push('flush');
  }

  return `${lines.join('\n')}\n`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function execSafe(cmd) {
  if (DRY_RUN) {
    logger.info({ cmd }, '[DRY_RUN] skip exec');
    return;
  }
  try {
    execSync(cmd, { timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    const out = e.stdout?.toString() + e.stderr?.toString();
    throw new Error(`Command failed: ${cmd} -> ${out || e.message}`);
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isSafeIface(iface) {
  return typeof iface === 'string' && /^[A-Za-z0-9_.:-]+$/.test(iface);
}

function isIpv6Literal(ipv6) {
  return typeof ipv6 === 'string' && ipv6.includes(':') && /^[0-9A-Fa-f:]+$/.test(ipv6);
}

function ipErrorText(e) {
  return `${e.stdout?.toString() || ''}${e.stderr?.toString() || ''}${e.message || ''}`;
}

function runIp(args, options = {}) {
  return execFileSync('ip', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout || 10000,
    ...options,
  });
}

function canManageIpv6(ipv6) {
  if (DRY_RUN || !MANAGE_IPV6_ADDRS) return false;
  if (!isIpv6Literal(ipv6)) {
    logger.warn({ ipv6 }, 'Skip IPv6 interface bind: invalid IPv6 literal');
    return false;
  }
  if (!isSafeIface(IPV6_INTERFACE)) {
    logger.warn({ iface: IPV6_INTERFACE }, 'Skip IPv6 interface bind: invalid interface');
    return false;
  }
  return true;
}

function currentInterfaceIpv6Set() {
  if (DRY_RUN || !MANAGE_IPV6_ADDRS || !isSafeIface(IPV6_INTERFACE)) return new Set();
  try {
    const out = runIp(['-6', 'addr', 'show', 'dev', IPV6_INTERFACE], {
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const found = new Set();
    for (const match of out.matchAll(/\binet6\s+([0-9a-f:]+)/ig)) found.add(match[1].toLowerCase());
    return found;
  } catch (e) {
    logger.warn({ iface: IPV6_INTERFACE, err: ipErrorText(e) }, 'Unable to inspect IPv6 interface');
    return new Set();
  }
}

function ensureIpv6OnInterface(ipv6) {
  if (!canManageIpv6(ipv6)) return;
  try {
    runIp(['-6', 'addr', 'add', `${ipv6}/${IPV6_ASSIGN_PREFIX}`, 'dev', IPV6_INTERFACE]);
  } catch (e) {
    const msg = ipErrorText(e);
    if (!/File exists|exists/i.test(msg)) logger.warn({ ipv6, iface: IPV6_INTERFACE, err: msg }, 'IPv6 interface assign failed');
  }
  if (MANAGE_NDP_PROXY) {
    try { runIp(['-6', 'neigh', 'replace', 'proxy', ipv6, 'dev', IPV6_INTERFACE]); } catch (e) {
      logger.warn({ ipv6, iface: IPV6_INTERFACE, err: ipErrorText(e) }, 'IPv6 NDP proxy update failed');
    }
  }
}

function removeIpv6FromInterface(ipv6) {
  if (!canManageIpv6(ipv6)) return;
  try {
    runIp(['-6', 'addr', 'del', `${ipv6}/${IPV6_ASSIGN_PREFIX}`, 'dev', IPV6_INTERFACE]);
  } catch (e) {
    const msg = ipErrorText(e);
    if (!/Cannot assign requested address|No such process|not found/i.test(msg)) {
      logger.warn({ ipv6, iface: IPV6_INTERFACE, err: msg }, 'IPv6 interface remove failed');
    }
  }
  if (MANAGE_NDP_PROXY) {
    try { runIp(['-6', 'neigh', 'del', 'proxy', ipv6, 'dev', IPV6_INTERFACE]); } catch (_) {}
  }
}

function ensureIpv6PoolOnInterface(ips) {
  if (!ips.length || DRY_RUN || !MANAGE_IPV6_ADDRS || !isSafeIface(IPV6_INTERFACE)) return;
  const existing = currentInterfaceIpv6Set();
  const missing = ips.filter((ip) => !existing.has(ip.toLowerCase()));
  if (missing.length === 0) return;

  const commands = missing.map((ip) => ['-6', 'addr', 'replace', `${ip}/${IPV6_ASSIGN_PREFIX}`, 'dev', IPV6_INTERFACE]);
  if (MANAGE_NDP_PROXY) commands.push(...missing.map((ip) => ['-6', 'neigh', 'replace', 'proxy', ip, 'dev', IPV6_INTERFACE]));

  let failures = 0;
  const chunkSize = Math.max(1, parseInt(process.env.IP_BIND_BATCH_SIZE || '250', 10) || 250);
  for (let i = 0; i < commands.length; i += chunkSize) {
    const chunk = commands.slice(i, i + chunkSize);
    try {
      runIp(['-6', '-batch', '-'], {
        input: `${chunk.map((args) => (args[0] === '-6' ? args.slice(1) : args).join(' ')).join('\n')}\n`,
        timeout: Math.max(30000, chunk.length * 200),
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      logger.warn({ iface: IPV6_INTERFACE, batch: i / chunkSize, err: ipErrorText(e) }, 'IPv6 batch bind failed, retrying individually');
      for (const args of chunk) {
        try { runIp(args); } catch (singleError) {
          failures++;
          logger.warn({ iface: IPV6_INTERFACE, cmd: args.join(' '), err: ipErrorText(singleError) }, 'IPv6 bind command failed');
        }
      }
    }
  }
  if (failures >= missing.length) throw new Error(`Unable to bind rotating IPv6 pool on ${IPV6_INTERFACE}`);
  logger.info({ iface: IPV6_INTERFACE, bound: missing.length - failures, failed: failures }, 'Rotating IPv6 pool bind finished');
}

function ensureRotatingPool(size = DEFAULT_ROTATING_POOL_SIZE) {
  const target = Math.max(1, parseInt(size, 10) || DEFAULT_ROTATING_POOL_SIZE);
  let pool = db.prepare(`
    SELECT ipv6
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
  `).all(target).map((row) => row.ipv6);
  if (pool.length < target) {
    const needed = target - pool.length;
    const moved = db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, ipv6
        FROM ipv6_pool
        WHERE status='available' AND COALESCE(health_status, 'unknown') != 'bad'
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
      `).all(needed);
      if (rows.length < needed) {
        throw Object.assign(new Error(`Rotating pool needs ${needed} more IPv6 addresses, only ${rows.length} available`), { code: 'INSUFFICIENT_POOL' });
      }
      const update = db.prepare(
        `UPDATE ipv6_pool
         SET status='rot_pool',
             assigned_order_id=NULL,
             assigned_at=datetime('now'),
             cooldown_until=NULL,
             health_status=CASE WHEN COALESCE(health_status, 'unknown') = 'bad' THEN 'unknown' ELSE COALESCE(health_status, 'unknown') END
         WHERE id=?`,
      );
      for (const row of rows) update.run(row.id);
      return rows.map((row) => row.ipv6);
    })();
    pool = pool.concat(moved);
  }

  const bindingKey = `${target}:${pool.join(',')}`;
  if (bindingKey !== rotatingPoolBindingKey) {
    ensureIpv6PoolOnInterface(pool);
    rotatingPoolBindingKey = bindingKey;
  }
  return pool;
}

function splitIntoGroups(pool) {
  const groupCount = Math.min(ROTATING_POOL_GROUPS, Math.max(1, pool.length));
  const groupSize = Math.ceil(pool.length / groupCount);
  const groups = [];
  for (let i = 0; i < groupCount; i++) {
    const ips = pool.slice(i * groupSize, (i + 1) * groupSize);
    if (ips.length > 0) groups.push(ips);
  }
  return groups;
}

function poolChildPort(index) {
  return POOL_CHILD_PORT_START + index;
}

function poolGroupPort(index) {
  return POOL_GROUP_PORT_START + index;
}

function isPortListening(port) {
  if (DRY_RUN) return true;
  try {
    const out = execFileSync('ss', ['-ltn'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    return out.split('\n').some((line) => new RegExp(`:${Number(port)}\\s`).test(line));
  } catch (_) {
    return false;
  }
}

function waitForPortsListening(ports, timeoutMs = PROXY_START_WAIT_MS) {
  const expected = ports.filter(Boolean);
  if (expected.length === 0 || DRY_RUN) return true;
  const deadline = Date.now() + timeoutMs;
  do {
    if (expected.every((port) => isPortListening(port))) return true;
    sleepMs(Math.min(PROXY_START_CHECK_MS, 500));
  } while (Date.now() < deadline);
  return expected.every((port) => isPortListening(port));
}

function listeningPids(port) {
  if (DRY_RUN) return [];
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (!new RegExp(`:${Number(port)}\\s`).test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    }
    return [...pids];
  } catch (_) {
    return [];
  }
}

function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || DRY_RUN) return;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmdline.includes('3proxy')) return;
    process.kill(pid, 'SIGTERM');
  } catch (_) {}
}

function killByPidFile(processId) {
  if (DRY_RUN) return;
  const pidFile = pidPathFor(processId);
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    stopPid(pid);
  } catch (_) {}
  try { fs.unlinkSync(pidFile); } catch (_) {}
}

function killProxyProcess(port, processId = processIdFor(port)) {
  if (DRY_RUN) return;
  killByPidFile(processId);
  for (const pid of listeningPids(port)) stopPid(pid);
  sleepMs(350);
  try { fs.unlinkSync(pidPathFor(processId)); } catch (_) {}
}

function stopPorts(ports) {
  const seen = new Set();
  for (const port of ports) {
    const n = Number(port);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    for (const pid of listeningPids(n)) stopPid(pid);
  }
  sleepMs(500);
}

function startDirectProxyProcess({ port, cfgPath, processId, force = false }) {
  if (DRY_RUN) return;
  if (force) killProxyProcess(port, processId);
  if (!force && port && isPortListening(port)) return;
  const cmd = `ulimit -n ${PROXY_NOFILE}; exec /usr/local/bin/3proxy ${shellQuote(cfgPath)}`;
  const proc = spawn('/bin/bash', ['-lc', cmd], { detached: true, stdio: 'ignore' });
  proc.unref();
  const deadline = Date.now() + PROXY_START_WAIT_MS;
  do {
    sleepMs(PROXY_START_CHECK_MS);
    if (!port || isPortListening(port)) return;
  } while (Date.now() < deadline);
  throw new Error(`3proxy port ${port} is not listening after ${PROXY_START_WAIT_MS}ms`);
}

function startStaticProxyProcess(port) {
  if (DRY_RUN) return;
  try {
    execSafe(`systemctl start 3proxy@${port}`);
    sleepMs(700);
    if (isPortListening(port)) return;
  } catch (e) {
    logger.warn({ port, err: e.message }, 'systemctl start failed, trying direct 3proxy');
  }
  killProxyProcess(port);
  startDirectProxyProcess({ port, cfgPath: configPath(port), processId: processIdFor(port) });
}

function ensureSharedRotatingPool(size = DEFAULT_ROTATING_POOL_SIZE) {
  ensureConfigDir();
  const pool = ensureRotatingPool(size);
  const groups = splitIntoGroups(pool);
  const groupPorts = groups.map((_, index) => poolGroupPort(index));
  const childServices = [];
  groups.forEach((ips, groupIndex) => {
    ips.forEach((ipv6, ipIndex) => {
      childServices.push({
        port: poolChildPort(groupIndex * Math.ceil(pool.length / groups.length) + ipIndex),
        listenIp: '127.0.0.1',
        ipv6,
      });
    });
  });
  const childShards = [];
  for (let i = 0; i < childServices.length; i += POOL_CHILD_SHARD_SIZE) {
    childShards.push({
      index: childShards.length,
      services: childServices.slice(i, i + POOL_CHILD_SHARD_SIZE),
    });
  }
  for (const shard of childShards) {
    const childCfg = renderMultiProxyConfig({
      processId: poolChildProcessId(shard.index),
      services: shard.services,
      maxconn: Math.max(2000, shard.services.length + 200),
    });
    shard.changed = writeIfChanged(poolChildConfigPath(shard.index), childCfg);
  }

  const groupServices = groups.map((ips, groupIndex) => ({
    port: groupPorts[groupIndex],
    listenIp: '127.0.0.1',
    parents: ips.map((_, ipIndex) => ({
      weight: parentWeight(ips.length),
      type: 'http',
      host: '127.0.0.1',
      port: poolChildPort(groupIndex * Math.ceil(pool.length / groups.length) + ipIndex),
    })),
  }));
  const groupCfg = renderMultiProxyConfig({
    processId: POOL_GROUP_PROCESS_ID,
    services: groupServices,
    maxconn: Math.max(2000, groupServices.length + 200),
    allowUser: POOL_INTERNAL_USER,
  })
    .replace('auth none\n', `auth strong\nusers ${POOL_INTERNAL_USER}:CL:${POOL_INTERNAL_PASS}\n`);
  const groupChanged = writeIfChanged(poolGroupConfigPath(), groupCfg);

  killByPidFile(POOL_CHILD_PROCESS_ID);
  try { fs.unlinkSync(path.join(CONFIG_DIR, 'rotating-pool-children.cfg')); } catch (_) {}

  for (const shard of childShards) {
    const samplePorts = [shard.services[0]?.port, shard.services[shard.services.length - 1]?.port].filter(Boolean);
    const shardHealthy = samplePorts.length > 0 && samplePorts.every((port) => isPortListening(port));
    if (!shardHealthy || shard.changed) {
      let started = false;
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !started; attempt++) {
        killByPidFile(poolChildProcessId(shard.index));
        stopPorts(samplePorts);
        try {
          startDirectProxyProcess({
            port: shard.services[0]?.port,
            cfgPath: poolChildConfigPath(shard.index),
            processId: poolChildProcessId(shard.index),
            force: false,
          });
          started = waitForPortsListening(samplePorts);
          if (!started) lastError = new Error(`shard ${shard.index} sample ports did not become ready`);
        } catch (e) {
          lastError = e;
        }
      }
      if (!started) throw lastError || new Error(`Unable to start rotating pool child shard ${shard.index}`);
    }
  }
  // Stop stale child shards when the active healthy pool is smaller than the inventory.
  // Their ports are not referenced by the group router after the config rewrite.
  for (let staleIndex = childShards.length; staleIndex < 100; staleIndex++) {
    const stalePid = `/var/run/${poolChildProcessId(staleIndex)}.pid`;
    if (!fs.existsSync(stalePid)) continue;
    killByPidFile(poolChildProcessId(staleIndex));
  }

  const groupSamplePorts = [groupPorts[0], groupPorts[groupPorts.length - 1]].filter(Boolean);
  const groupHealthy = groupSamplePorts.length > 0 && groupSamplePorts.every((port) => isPortListening(port));
  if (!groupHealthy || groupChanged) {
    let started = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      killByPidFile(POOL_GROUP_PROCESS_ID);
      stopPorts(groupSamplePorts);
      try {
        startDirectProxyProcess({ port: groupPorts[0], cfgPath: poolGroupConfigPath(), processId: POOL_GROUP_PROCESS_ID, force: false });
        started = waitForPortsListening(groupSamplePorts);
        if (!started) lastError = new Error('rotating pool group sample ports did not become ready');
      } catch (e) {
        lastError = e;
      }
    }
    if (!started) throw lastError || new Error('Unable to start rotating pool group');
  }

  logger.info({ poolSize: pool.length, groups: groupPorts.length, childPorts: childServices.length, childShards: childShards.length }, 'Shared rotating pool ensured');
  return { pool, groups, groupPorts };
}

function renderRotatingFront({ port, username, password, protocol, poolSize }) {
  const { groupPorts } = ensureSharedRotatingPool(poolSize || DEFAULT_ROTATING_POOL_SIZE);
  const weight = parentWeight(groupPorts.length);
  return renderConfig({
    port,
    username,
    password,
    protocol,
    listenIp: BIND_IP,
    pidfile: pidPathFor(processIdFor(port)),
    logPath: proxyLogPath(port),
    parentUpstreams: groupPorts.map((groupPort) => ({
      weight,
      type: 'http',
      host: '127.0.0.1',
      port: groupPort,
      username: POOL_INTERNAL_USER,
      password: POOL_INTERNAL_PASS,
    })),
  });
}

function createProxy({ port, ipv6, username, password, protocol, poolMode = false, poolSize }) {
  ensureConfigDir();
  ensureProxyLogDir();
  const cfg = poolMode
    ? renderRotatingFront({ port, username, password, protocol, poolSize })
    : renderConfig({ port, ipv6, username, password, protocol });
  fs.writeFileSync(configPath(port), cfg, 'utf8');

  if (!poolMode && !DRY_RUN) ensureIpv6OnInterface(ipv6);
  if (poolMode) {
    killProxyProcess(port);
    startDirectProxyProcess({ port, cfgPath: configPath(port), processId: processIdFor(port), force: false });
  } else {
    startStaticProxyProcess(port);
  }
  logger.info({ port, ipv6, protocol, poolMode }, '3proxy config written');
}

function ensureRotatingProxy({ port, username, password, protocol, poolSize }) {
  const cfg = renderRotatingFront({ port, username, password, protocol, poolSize });
  const cfgFile = configPath(port);
  let previous = null;
  try { previous = fs.readFileSync(cfgFile, 'utf8'); } catch (_) {}
  if (previous !== cfg) {
    fs.writeFileSync(cfgFile, cfg, 'utf8');
    reloadProxy(port);
    return;
  }
  if (isPortListening(port)) return;
  startDirectProxyProcess({ port, cfgPath: cfgFile, processId: processIdFor(port), force: false });
}

function removeProxy(port, ipv6 = '') {
  try { execSafe(`systemctl stop 3proxy@${port}`); } catch (_) {}
  killProxyProcess(port);
  try { fs.unlinkSync(configPath(port)); } catch (_) {}
  if (ipv6) removeIpv6FromInterface(ipv6);
  try { fs.unlinkSync(proxyLogPath(port)); } catch (_) {}
  logger.info({ port }, 'Proxy removed');
}

function reloadProxy(port, newCfg) {
  if (newCfg) {
    ensureConfigDir();
    ensureProxyLogDir();
    fs.writeFileSync(configPath(port), newCfg, 'utf8');
  }
  if (DRY_RUN) return;
  try { execSafe(`systemctl stop 3proxy@${port}`); } catch (_) {}
  killProxyProcess(port);
  startDirectProxyProcess({ port, cfgPath: configPath(port), processId: processIdFor(port), force: false });
}

function rotateProxy({ port, newIpv6, oldIpv6 = '', username, password, protocol, poolMode = false, poolSize }) {
  if (poolMode) {
    ensureRotatingProxy({ port, username, password, protocol, poolSize });
    logger.info({ port, poolSize: poolSize || DEFAULT_ROTATING_POOL_SIZE }, 'Pool proxy kept alive; no request rotation restart');
    return;
  }
  const cfg = renderConfig({ port, ipv6: newIpv6, username, password, protocol });
  ensureIpv6OnInterface(newIpv6);
  reloadProxy(port, cfg);
  if (oldIpv6 && oldIpv6 !== newIpv6) removeIpv6FromInterface(oldIpv6);
  logger.info({ port, newIpv6 }, 'Proxy rotated');
}

module.exports = {
  createProxy,
  ensureRotatingProxy,
  ensureSharedRotatingPool,
  removeProxy,
  reloadProxy,
  rotateProxy,
  renderConfig,
  configPath,
  proxyLogPath,
  ensureRotatingPool,
  poolParentWeight: parentWeight,
  CONFIG_DIR,
  PROXY_LOG_DIR,
  ensureIpv6OnInterface,
  removeIpv6FromInterface,
};
