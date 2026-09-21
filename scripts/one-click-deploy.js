#!/usr/bin/env node
// one-click-deploy.js — All-in-One 1 click: Git push + SSH deploy + bootstrap full
// Chạy: node scripts/one-click-deploy.js
// Hoặc: npm run deploy
// Không cần sshpass/WSL/Git Bash — chạy thẳng trên Windows/Mac/Linux
// Yêu cầu: Node 18+, VPS Ubuntu 22.04 đã có /64

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VPS_HOST = process.env.VPS_HOST || '160.187.246.219';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_PASS = process.env.VPS_PASS || '@5Dr6_#e2z';
const VPS_PORT = process.env.VPS_PORT || '22';
const REPO_URL = process.env.REPO_URL || 'https://github.com/dinhhoi254/IPV6-Server.git';
const POOL = process.env.POOL || '7000';
const PREFIX = process.env.PREFIX || ''; // để trống = tự dò trên VPS
const DOMAIN = process.env.DOMAIN || '';
const EMAIL = process.env.EMAIL || '';
const INSTALL_DIR = '/opt/ipv6-proxy';

const ROOT = path.resolve(__dirname, '..');

function log(msg) { console.log(msg); }
function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

async function ensureDeps() {
  try { require.resolve('ssh2'); } catch {
    log('>> Cài ssh2 (1 lần)...');
    execSync('npm install --no-save ssh2 archiver', { stdio: 'inherit', cwd: ROOT });
  }
}

function gitPush() {
  log('\n=== [1/4] Git push lên GitHub ===');
  try {
    // Sửa repo url nếu lệch
    try {
      const remote = execSync('git remote get-url origin', { encoding: 'utf8', cwd: ROOT }).trim();
      if (!remote.includes('dinhhoi254/IPV6-Server')) {
        log(`  Remote hiện tại: ${remote} -> đổi sang ${REPO_URL}`);
        execSync(`git remote set-url origin ${REPO_URL}`, { stdio: 'inherit', cwd: ROOT });
      }
    } catch { execSync(`git remote add origin ${REPO_URL}`, { stdio: 'inherit', cwd: ROOT }); }

    run('git add -A');
    try { run('git commit -m "deploy: all-in-one"'); } catch { log('  (nothing to commit)'); }
    run('git push -u origin main');
    log('  >> Git push OK');
  } catch (e) {
    log('  !! Git push lỗi (có thể cần token ghp_xxx). Bỏ qua, vẫn deploy từ local qua SFTP.');
  }
}

async function deployViaSsh() {
  const { Client } = require('ssh2');
  log(`\n=== [2/4] SSH ${VPS_USER}@${VPS_HOST}:${VPS_PORT} ===`);

  // Pack local thành tar.gz (Node, không cần tar hệ thống)
  const archiver = require('archiver');
  const tmpTar = path.join(os.tmpdir(), `ipv6-proxy-${Date.now()}.tar.gz`);
  log(`  Nén ${ROOT} -> ${tmpTar}`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmpTar);
    const archive = archiver('tar', { gzip: true });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    // Chỉ pack file cần thiết
    const include = ['package.json', 'package-lock.json', 'server.js', 'ecosystem.config.js', '.env.example', 'README.md', 'HUONG-DAN-SU-DUNG.md', 'TAI-LIEU-TICH-HOP.md'];
    for (const f of include) if (fs.existsSync(path.join(ROOT, f))) archive.file(path.join(ROOT, f), { name: f });
    for (const dir of ['src', 'templates', 'scripts', 'configs']) {
      const p = path.join(ROOT, dir);
      if (fs.existsSync(p)) archive.directory(p, dir);
    }
    archive.finalize();
  });
  log(`  Pack xong: ${(fs.statSync(tmpTar).size / 1024).toFixed(0)} KB`);

  // SSH connect
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host: VPS_HOST, port: parseInt(VPS_PORT, 10),
      username: VPS_USER, password: VPS_PASS,
      readyTimeout: 15000, keepaliveInterval: 10000,
    });
  });
  log('  SSH connected');

  const exec = (cmd) => new Promise((resolve, reject) => {
    log(`\n$ ${cmd}\n`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', (code) => {
        if (out) process.stdout.write(out);
        if (errOut) process.stderr.write(errOut);
        if (code !== 0) log(`  (exit ${code})`);
        resolve({ code, out, errOut });
      }).on('data', d => { out += d; process.stdout.write(d); })
        .stderr.on('data', d => { errOut += d; process.stderr.write(d); });
    });
  });

  // Upload tar qua SFTP
  log('\n=== [3/4] Upload code lên VPS ===');
  await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.mkdir(INSTALL_DIR, () => {});
      const remote = '/tmp/ipv6-proxy.tar.gz';
      const ws = sftp.createWriteStream(remote);
      fs.createReadStream(tmpTar).pipe(ws).on('close', () => resolve()).on('error', reject);
    });
  });
  log('  Upload xong');

  // Giải nén + bootstrap
  log('\n=== [4/4] Bootstrap trên VPS (tự dò prefix, cài full, mở port) ===');
  const bootArgs = [`--pool ${POOL}`, `--dir ${INSTALL_DIR}`];
  if (PREFIX) bootArgs.push(`--prefix ${PREFIX}`);
  if (DOMAIN) bootArgs.push(`--domain ${DOMAIN}`);
  if (EMAIL) bootArgs.push(`--email ${EMAIL}`);

  // Giải nén trước
  await exec(`mkdir -p ${INSTALL_DIR} && tar -xzf /tmp/ipv6-proxy.tar.gz -C ${INSTALL_DIR} && rm -f /tmp/ipv6-proxy.tar.gz && chmod +x ${INSTALL_DIR}/scripts/*.sh && ls -lh ${INSTALL_DIR}/scripts/ | head -20`);

  // Chạy bootstrap (có thể 3-5 phút)
  const r = await exec(`bash ${INSTALL_DIR}/scripts/bootstrap.sh ${bootArgs.join(' ')} 2>&1`);
  if (r.code !== 0) {
    log('\n!! Bootstrap lỗi, thử cài lại nginx + mở port:');
    await exec(`bash ${INSTALL_DIR}/scripts/setup-nginx.sh ${VPS_HOST} 2>&1 || true; ufw allow 30000:40000/tcp 2>&1; ufw allow 30000:40000/udp 2>&1; ufw allow 443/tcp 2>&1; ufw --force enable 2>&1 | tail -5; echo "---"; curl -s http://127.0.0.1:8080/health 2>&1 | head -20; pm2 list 2>&1 | head -20`);
  }

  // Verify
  log('\n=== Verify ===');
  await exec(`echo "--- health ---" && curl -s http://127.0.0.1:8080/health 2>&1 | python3 -m json.tool 2>&1 || curl -s http://127.0.0.1:8080/health 2>&1 | head -20; echo ""; echo "--- public health ---" && curl -s http://${VPS_HOST}/health 2>&1 | head -20; echo ""; echo "--- PM2 ---" && pm2 list 2>&1 | head -20; echo ""; echo "--- Pool ---" && sqlite3 ${INSTALL_DIR}/data/app.db "SELECT status, COUNT(*) FROM ipv6_pool GROUP BY status;" 2>&1 || echo "(pool chưa có)"; echo ""; echo "--- ufw ---" && ufw status 2>&1 | head -20; echo ""; echo "--- listen ---" && ss -tlnp 2>&1 | grep -E "8080|3000" | head -10; echo ""; echo "--- .env ---" && grep -E "^(ADMIN_API_KEY|PUBLIC_IP|IPV6_PREFIX)=" ${INSTALL_DIR}/.env 2>&1 | sed 's/^/  /'`);

  conn.end();
  try { fs.unlinkSync(tmpTar); } catch {}
  log('\n======================================================');
  log('  XONG! Test từ máy local:');
  log(`  curl http://${VPS_HOST}/health`);
  log(`  ADMIN_KEY=$(ssh ${VPS_USER}@${VPS_HOST} "grep ADMIN_API_KEY ${INSTALL_DIR}/.env | cut -d= -f2-")`);
  log('======================================================');
}

(async () => {
  try {
    await ensureDeps();
    gitPush();
    await deployViaSsh();
  } catch (e) {
    console.error('\n[FAIL]', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
})();
