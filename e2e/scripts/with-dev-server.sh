#!/usr/bin/env bash
# GAS dev-server(:8787, NODE_ENV=test)をバックグラウンド起動し、起動を待って引数のコマンドを実行、終了時に停止する。
# firebase emulators:exec の中で呼ばれる想定（FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST が設定済み）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GAS_DIR="$HERE/../../gas"
PORT="${PORT:-8787}"
export NODE_ENV=test PORT FCM_ENABLED=0 ENABLE_TEST_ENDPOINTS=1
PORT_RL="${PORT_RL:-8788}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-demo-kosodate-hub}"
# テスト用のローカル Drive は毎回作り直す
export LOCAL_DRIVE_DIR="${LOCAL_DRIVE_DIR:-$GAS_DIR/.local-drive}"
rm -rf "$LOCAL_DRIVE_DIR"

# 本体: 回数制限は無効（他テストが 60/分 等に当たらないように）
( cd "$GAS_DIR" && DISABLE_RATE_LIMIT=1 exec npx tsx core/dev-server.ts ) >"$HERE/../dev-server.log" 2>&1 &
SERVER_PID=$!
# 回数制限テスト用: 制限が有効な別プロセス（PORT_RL）
( cd "$GAS_DIR" && PORT="$PORT_RL" exec npx tsx core/dev-server.ts ) >"$HERE/../dev-server-rl.log" 2>&1 &
SERVER_RL_PID=$!
cleanup() {
  for p in "$SERVER_PID" "$SERVER_RL_PID"; do kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "dev-server が起動できません:"; cat "$HERE/../dev-server.log"; exit 1; fi
  sleep 0.5
done
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT_RL/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT_RL/" >/dev/null || { echo "rate-limit 用 dev-server が起動しません"; cat "$HERE/../dev-server-rl.log"; exit 1; }
curl -sf "http://127.0.0.1:$PORT/" >/dev/null || { echo "dev-server の起動待ちがタイムアウト"; cat "$HERE/../dev-server.log"; exit 1; }

"$@"
