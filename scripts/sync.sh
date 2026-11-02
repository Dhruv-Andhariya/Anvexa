#!/usr/bin/env bash
# Run this after EVERY pull / at the start of each day:  pnpm sync
# Brings your laptop fully up to date with main so everyone's modules work together.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/4 Pulling latest code (rebase keeps history clean)..."
git pull --rebase --autostash

echo "2/4 Installing JS dependencies..."
pnpm install

echo "3/4 Installing Python dependencies..."
if command -v uv >/dev/null 2>&1; then (cd workers/ai-worker && uv sync); else echo "  uv not found - skipping Python"; fi

echo "4/4 Applying database migrations (if Prisma is set up yet)..."
if [ -x apps/api/node_modules/.bin/prisma ]; then
  pnpm --filter api exec prisma migrate deploy && pnpm --filter api exec prisma generate
else
  echo "  Prisma not installed yet - skipping"
fi
echo "Done. Next: docker compose -f infra/docker/docker-compose.yml up -d  &&  pnpm dev"
