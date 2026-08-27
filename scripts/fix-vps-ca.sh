#!/usr/bin/env bash
# Fix Node.js TLS errors (SELF_SIGNED_CERT_IN_CHAIN) when calling T-Bank / ProxyAPI.
set -euo pipefail

echo "Updating CA certificates..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates openssl curl

update-ca-certificates --fresh

echo ""
echo "Testing HTTPS to T-Bank..."
if curl -fsS --max-time 15 https://securepay.tinkoff.ru/v2/Init -o /dev/null; then
  echo "OK: securepay.tinkoff.ru reachable with valid TLS."
else
  echo "WARN: curl test failed — check firewall or DNS."
fi

echo ""
echo "Next steps on the app:"
echo "1. Set INSECURE_TLS=false in /var/www/raskusime/.env"
echo "2. pm2 restart raskusi"
echo "3. curl -s https://raskusime.ru/api/health | grep insecureTls"
