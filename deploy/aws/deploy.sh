#!/bin/bash
# Rolls the API container on the EC2 host. Run as root (GitHub Actions sends it over SSM):
#   bash deploy.sh <image-tag>
#
# Runtime config lives in SSM Parameter Store, never in the image:
#   /sahasra/api/<ENV_NAME>        -> one env var each (SecureString for secrets)
#   /sahasra/files/firebase-admin  -> Firebase service-account JSON, mounted read-only
set -euo pipefail

TAG="${1:-latest}"
REGION=ap-southeast-2
ACCOUNT=961913912951
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="$REGISTRY/sahasra-backend:$TAG"
APP_DIR=/opt/sahasra
API_DOMAIN="${API_DOMAIN:-api.sahasrafamilysalon.in}"

mkdir -p "$APP_DIR/secrets"
chmod 700 "$APP_DIR"

# --- config ------------------------------------------------------------------
umask 077
aws ssm get-parameters-by-path --region "$REGION" --path /sahasra/api/ --with-decryption \
  --query "Parameters[].[Name,Value]" --output text \
  | while IFS=$'\t' read -r name value; do printf '%s=%s\n' "${name##*/}" "$value"; done \
  > "$APP_DIR/api.env"

aws ssm get-parameter --region "$REGION" --name /sahasra/files/firebase-admin --with-decryption \
  --query Parameter.Value --output text > "$APP_DIR/secrets/firebase-admin.json"
# RDS CA bundle so DATABASE_URL can use sslmode=verify-full.
curl -fsSL -o "$APP_DIR/secrets/rds-ca.pem" \
  "https://truststore.pki.rds.amazonaws.com/$REGION/$REGION-bundle.pem"
# The container runs as the unprivileged `node` user (uid 1000).
chown -R 1000:1000 "$APP_DIR/secrets"
chmod 500 "$APP_DIR/secrets"
chmod 400 "$APP_DIR/secrets/"*

cat > "$APP_DIR/Caddyfile" <<EOF
$API_DOMAIN {
	encode gzip
	reverse_proxy sahasra-api:8080
}
EOF
chmod 644 "$APP_DIR/Caddyfile"

# --- image -------------------------------------------------------------------
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker pull "$IMAGE"
docker network inspect sahasra >/dev/null 2>&1 || docker network create sahasra

docker rm -f sahasra-api >/dev/null 2>&1 || true
docker run -d --name sahasra-api --network sahasra --restart unless-stopped \
  --env-file "$APP_DIR/api.env" \
  -e PORT=8080 -e TRUST_PROXY=1 \
  -e FIREBASE_SERVICE_ACCOUNT_PATH=/run/secrets/firebase-admin.json \
  -v "$APP_DIR/secrets:/run/secrets:ro" \
  --log-opt max-size=20m --log-opt max-file=5 \
  "$IMAGE"

# Caddy terminates HTTPS (automatic Let's Encrypt) once DNS points at this host.
if docker inspect caddy >/dev/null 2>&1; then
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
else
  docker run -d --name caddy --network sahasra --restart unless-stopped \
    -p 80:80 -p 443:443 \
    -v "$APP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v caddy_data:/data -v caddy_config:/config \
    --log-opt max-size=10m --log-opt max-file=3 \
    caddy:2.10-alpine
fi

# --- wait for the Dockerfile HEALTHCHECK (/ready: DB reachable) ---------------
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' sahasra-api 2>/dev/null || echo missing)
  if [ "$status" = healthy ]; then
    echo "sahasra-api healthy ($TAG)"
    docker image prune -af --filter "until=72h" >/dev/null || true
    exit 0
  fi
  sleep 5
done

echo "sahasra-api did not become healthy (status: $status)" >&2
docker logs --tail 80 sahasra-api >&2 || true
exit 1
