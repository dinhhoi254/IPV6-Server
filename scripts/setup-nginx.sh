#!/bin/bash
set -e
# setup-nginx.sh — Cấu hình Nginx reverse proxy + Let's Encrypt
# Usage: bash scripts/setup-nginx.sh <domain> [email]
#   domain: ví dụ proxy.example.com
#   email:  email cho Let's Encrypt (bắt buộc nếu muốn HTTPS)

DOMAIN="$1"
EMAIL="$2"

if [ -z "$DOMAIN" ]; then
  echo "Usage: bash scripts/setup-nginx.sh <domain> [email]"
  echo "  Ví dụ: bash scripts/setup-nginx.sh proxy.example.com admin@example.com"
  exit 1
fi

# Xác định project dir
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -f "$PROJECT_DIR/package.json" ] && [ -f "/opt/ipv6-proxy/package.json" ]; then
  PROJECT_DIR="/opt/ipv6-proxy"
fi

echo "Domain: $DOMAIN"
echo "Project: $PROJECT_DIR"

# Cài certbot nếu chưa có và có email
if [ -n "$EMAIL" ]; then
  if ! command -v certbot &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq certbot python3-certbot-nginx > /dev/null
  fi
fi

# Tạo config Nginx
NGINX_CONF="/etc/nginx/sites-available/ipv6-proxy"
cat > "$NGINX_CONF" <<NGINX
# IPv6 Proxy API — $DOMAIN
upstream ipv6_proxy_api {
    server 127.0.0.1:8080;
}

server {
    listen 80;
    server_name $DOMAIN;

    # ACME challenge cho Let's Encrypt
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://ipv6_proxy_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 90s;
        proxy_connect_timeout 10s;

        # Giới hạn body
        client_max_body_size 1m;
    }

    # Log
    access_log /var/log/nginx/ipv6-proxy-access.log;
    error_log /var/log/nginx/ipv6-proxy-error.log;
}
NGINX

# Enable site
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/ipv6-proxy
# Xóa default nếu muốn (không bắt buộc)
# rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx 2>/dev/null || nginx -s reload

echo "Nginx đã cấu hình cho $DOMAIN (HTTP)"

# Cấp chứng chỉ Let's Encrypt nếu có email
if [ -n "$EMAIL" ]; then
  echo "Đang cấp chứng chỉ Let's Encrypt cho $DOMAIN ..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect || {
    echo "WARN: certbot thất bại. Kiểm tra DNS đã trỏ về IP VPS chưa."
    echo "Thử lại: certbot --nginx -d $DOMAIN --email $EMAIL --redirect"
  }
  # Auto renew cron đã có sẵn khi cài certbot
  echo "HTTPS đã sẵn sàng: https://$DOMAIN"
else
  echo "Bỏ qua Let's Encrypt (không có --email)."
  echo "Để cấp HTTPS sau: certbot --nginx -d $DOMAIN --email you@example.com --redirect"
fi

echo "Done. Kiểm tra: curl http://$DOMAIN/health"
