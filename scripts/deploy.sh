#!/bin/bash
set -e
# deploy.sh — Deploy từ máy LOCAL tới VPS qua SSH, tự login + setup full
# Chạy trên máy local (Linux/macOS/WSL/Git Bash trên Windows):
#
#   bash scripts/deploy.sh root@160.187.246.219
#   bash scripts/deploy.sh root@1.2.3.4 --password 'MyPass123' --pool 7000
#   bash scripts/deploy.sh root@1.2.3.4 --key ~/.ssh/id_rsa
#   bash scripts/deploy.sh root@1.2.3.4 --prefix 2001:db8:abcd::/64 --domain proxy.example.com --email admin@example.com
#
# Nếu không truyền --password/--key, sẽ dùng SSH key mặc định / ssh-agent.
# Hỗ trợ nhiều VPS: lặp lại lệnh hoặc truyền danh sách.

VPS=""
VPS_PASSWORD=""
VPS_KEY=""
PREFIX=""
POOL="7000"
DOMAIN=""
EMAIL=""
REPO=""
INSTALL_DIR="/opt/ipv6-proxy"
EXTRA_ARGS=""

usage() {
  echo "Usage: bash scripts/deploy.sh <user@host> [options]"
  echo ""
  echo "  <user@host>              Bắt buộc: ví dụ root@160.187.246.219"
  echo "  --password <pass>        Mật khẩu SSH (dùng sshpass)"
  echo "  --key <path>             Đường dẫn private key"
  echo "  --port <port>            SSH port (mặc định 22)"
  echo "  --prefix <ipv6/64>       Prefix IPv6, bỏ trống sẽ tự dò trên VPS"
  echo "  --pool <n>               Số IP pool (mặc định 7000)"
  echo "  --domain <domain>        Domain cho Nginx + Let's Encrypt"
  echo "  --email <email>          Email cho Let's Encrypt"
  echo "  --repo <git-url>         Git repo URL (mặc định: upload từ local)"
  echo "  --dir <path>             Thư mục cài trên VPS (mặc định /opt/ipv6-proxy)"
  echo "  --help"
  echo ""
  echo "Ví dụ:"
  echo "  bash scripts/deploy.sh root@160.187.246.219 --password '?BG8a\$s7D-'"
  echo "  bash scripts/deploy.sh root@1.2.3.4 --prefix 2001:db8::/64 --domain p.example.com --email a@b.com"
  exit 0
}

SSH_PORT="22"

# Parse: arg đầu tiên không có -- là VPS
if [ $# -eq 0 ]; then usage; fi
case "$1" in --help|-h) usage;; --*) echo "Thiếu <user@host> ở đầu"; usage;; *) VPS="$1"; shift;; esac

while [ $# -gt 0 ]; do
  case "$1" in
    --password) VPS_PASSWORD="$2"; shift 2;;
    --key) VPS_KEY="$2"; shift 2;;
    --port) SSH_PORT="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --dir) INSTALL_DIR="$2"; shift 2;;
    --help|-h) usage;;
    *) echo "Unknown arg: $1"; usage;;
  esac
done

# Xác định PROJECT_DIR local (thư mục chứa deploy.sh/..)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  LOCAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "./package.json" ]; then
  LOCAL_DIR="$(pwd)"
else
  LOCAL_DIR="$SCRIPT_DIR/.."
fi

# Build SSH base command
SSH_BASE="ssh -p $SSH_PORT -o StrictHostKeyChecking=no -o ConnectTimeout=15"
SCP_BASE="scp -P $SSH_PORT -o StrictHostKeyChecking=no -o ConnectTimeout=15"

if [ -n "$VPS_KEY" ]; then
  SSH_BASE="$SSH_BASE -i $VPS_KEY"
  SCP_BASE="$SCP_BASE -i $VPS_KEY"
fi

# Wrapper: nếu có password thì dùng sshpass
run_ssh() {
  if [ -n "$VPS_PASSWORD" ]; then
    if ! command -v sshpass &>/dev/null; then
      echo "Cài sshpass để dùng --password ..."
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq sshpass
      elif command -v pacman &>/dev/null; then
        pacman -Sy --noconfirm mingw-w64-x86_64-sshpass 2>/dev/null || pacman -Sy --noconfirm sshpass 2>/dev/null || pacman -S --noconfirm sshpass 2>/dev/null || {
          echo "Thử cài sshpass thủ công..."
          curl -fsSL https://sourceforge.net/projects/sshpass/files/sshpass/1.10/sshpass-1.10.tar.gz/download -o /tmp/sshpass.tar.gz 2>/dev/null && \
            (cd /tmp && tar xzf sshpass.tar.gz && cd sshpass-1.10 && ./configure && make && make install) 2>/dev/null || true
        }
      elif command -v brew &>/dev/null; then
        brew install hudochenkov/sshpass/sshpass 2>/dev/null || brew install sshpass
      else
        echo "ERROR: Không tìm thấy sshpass và không biết cách cài. Cài thủ công: apt install sshpass / brew install sshpass / pacman -S sshpass"
        exit 1
      fi
    fi
    sshpass -p "$VPS_PASSWORD" $SSH_BASE "$@"
  else
    $SSH_BASE "$@"
  fi
}

run_scp() {
  if [ -n "$VPS_PASSWORD" ]; then
    sshpass -p "$VPS_PASSWORD" $SCP_BASE "$@"
  else
    $SCP_BASE "$@"
  fi
}

echo "======================================================"
echo "  Deploy to $VPS (port $SSH_PORT)"
echo "  Local dir: $LOCAL_DIR"
echo "  Remote dir: $INSTALL_DIR"
[ -n "$PREFIX" ] && echo "  Prefix: $PREFIX" || echo "  Prefix: (tự dò trên VPS)"
echo "  Pool: $POOL"
[ -n "$DOMAIN" ] && echo "  Domain: $DOMAIN"
echo "======================================================"

# 1. Test SSH
echo ""
echo ">>> [1/4] Kiểm tra kết nối SSH ..."
if ! run_ssh "$VPS" "echo 'SSH OK: \$(hostname) \$(lsb_release -d 2>/dev/null | cut -f2)'"; then
  echo "ERROR: Không kết nối được tới $VPS. Kiểm tra IP/user/password/port."
  exit 1
fi

# 2. Upload code
echo ""
echo ">>> [2/4] Upload code lên VPS ..."
if [ -n "$REPO" ]; then
  echo "  Dùng git clone: $REPO"
  run_ssh "$VPS" "if [ ! -d $INSTALL_DIR/.git ]; then rm -rf $INSTALL_DIR; git clone $REPO $INSTALL_DIR; else cd $INSTALL_DIR && git fetch --all && git reset --hard origin/main 2>/dev/null || git reset --hard origin/master 2>/dev/null || git pull; fi"
else
  echo "  Upload từ local: $LOCAL_DIR -> $VPS:$INSTALL_DIR"
  # Nén local trừ node_modules/.git/data/logs
  TMP_TAR="/tmp/ipv6-proxy-$$.tar.gz"
  tar -czf "$TMP_TAR" \
    --exclude='node_modules' --exclude='.git' --exclude='data/*.db*' --exclude='logs' --exclude='.env' \
    -C "$LOCAL_DIR" \
    package.json package-lock.json server.js ecosystem.config.js .env.example \
    src templates scripts configs 2>/dev/null || \
  tar -czf "$TMP_TAR" --exclude='node_modules' --exclude='.git' -C "$LOCAL_DIR" . 2>/dev/null

  run_ssh "$VPS" "mkdir -p $INSTALL_DIR"
  run_scp "$TMP_TAR" "$VPS:/tmp/ipv6-proxy.tar.gz"
  rm -f "$TMP_TAR"
  run_ssh "$VPS" "tar -xzf /tmp/ipv6-proxy.tar.gz -C $INSTALL_DIR && rm -f /tmp/ipv6-proxy.tar.gz && chmod +x $INSTALL_DIR/scripts/*.sh && ls -la $INSTALL_DIR/scripts/"
fi

# 3. Chạy bootstrap trên VPS
echo ""
echo ">>> [3/4] Chạy bootstrap trên VPS ..."
BOOTSTRAP_ARGS="--pool $POOL --dir $INSTALL_DIR"
[ -n "$PREFIX" ] && BOOTSTRAP_ARGS="$BOOTSTRAP_ARGS --prefix $PREFIX"
[ -n "$DOMAIN" ] && BOOTSTRAP_ARGS="$BOOTSTRAP_ARGS --domain $DOMAIN"
[ -n "$EMAIL" ] && BOOTSTRAP_ARGS="$BOOTSTRAP_ARGS --email $EMAIL"
[ -n "$REPO" ] && BOOTSTRAP_ARGS="$BOOTSTRAP_ARGS --repo $REPO"

run_ssh "$VPS" "chmod +x $INSTALL_DIR/scripts/*.sh && bash $INSTALL_DIR/scripts/bootstrap.sh $BOOTSTRAP_ARGS 2>&1" || {
  echo "WARN: bootstrap trả về lỗi, kiểm tra log trên VPS: ssh $VPS 'cat /tmp/ipv6-proxy-bootstrap.log; pm2 logs --lines 50'"
  # Thử in log
  run_ssh "$VPS" "cat $INSTALL_DIR/logs/pm2-error.log 2>/dev/null | tail -50; cat $INSTALL_DIR/logs/app.log 2>/dev/null | tail -50" || true
  exit 1
}

# 4. Verify
echo ""
echo ">>> [4/4] Kiểm tra health ..."
run_ssh "$VPS" "curl -s http://127.0.0.1:8080/health | jq . 2>/dev/null || curl -s http://127.0.0.1:8080/health; echo ''; echo '--- PM2 ---'; pm2 list 2>/dev/null | head -20; echo ''; echo '--- Pool ---'; sqlite3 $INSTALL_DIR/data/app.db 'SELECT status, COUNT(*) FROM ipv6_pool GROUP BY status;' 2>/dev/null || echo '(pool check skipped)'"

echo ""
echo "======================================================"
echo "  Deploy xong: $VPS"
echo "  SSH:  ssh $VPS"
echo "  API:  ssh $VPS 'curl -s http://127.0.0.1:8080/health | jq .'"
run_ssh "$VPS" "grep -E '^(ADMIN_API_KEY|PUBLIC_IP|IPV6_PREFIX)=' $INSTALL_DIR/.env 2>/dev/null | sed 's/^/  /'" || true
echo "======================================================"
