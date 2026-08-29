#!/usr/bin/env bash
# Nginx + Let's Encrypt for raskusime.ru (Ubuntu/Debian VPS).
# Run on the server: sudo bash scripts/setup-nginx-https.sh
set -euo pipefail

DOMAIN="${1:-raskusime.ru}"
APP_PORT="${2:-3847}"
EMAIL="${3:-support@${DOMAIN}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0 [domain] [app_port] [email]"
  exit 1
fi

apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

cat >"/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};
    return 301 https://${DOMAIN}\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.${DOMAIN};
    return 301 https://${DOMAIN}\$request_uri;
}
EOF

ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default

if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  certbot certonly --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" -m "${EMAIL}" --agree-tos --non-interactive || \
  certbot certonly --standalone -d "${DOMAIN}" -d "www.${DOMAIN}" -m "${EMAIL}" --agree-tos --non-interactive
fi

nginx -t
systemctl reload nginx

echo ""
echo "Done. Check:"
echo "  curl -I http://${DOMAIN}/   # must be 301 -> https"
echo "  curl -I https://${DOMAIN}/favicon.ico"
echo ""
echo "In .env set: BASE_URL=https://${DOMAIN}"
echo "In Yandex Webmaster: main mirror https://${DOMAIN}, submit https://${DOMAIN}/sitemap.xml"
