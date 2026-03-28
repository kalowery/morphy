#!/usr/bin/env bash

set -euo pipefail

VICTORIA_BINARY="${VICTORIA_BINARY:-/opt/homebrew/bin/victoria-metrics}"
VICTORIA_TSDB_PATH="${VICTORIA_TSDB_PATH:-}"
VICTORIA_PORT="${VICTORIA_PORT:-9090}"
VICTORIA_LOG_PATH="${VICTORIA_LOG_PATH:-/tmp/morphy-victoria.log}"
VICTORIA_PID_PATH="${VICTORIA_PID_PATH:-/tmp/morphy-victoria.pid}"
VICTORIA_HOST="${VICTORIA_HOST:-127.0.0.1}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|status> [--storage-path /path/to/tsdb]

Environment overrides:
  VICTORIA_BINARY
  VICTORIA_TSDB_PATH
  VICTORIA_PORT
  VICTORIA_LOG_PATH
  VICTORIA_PID_PATH
  VICTORIA_HOST
EOF
}

write_state_file() {
  local pid="$1"
  local storage_path="$2"

  cat >"$VICTORIA_PID_PATH" <<EOF
PID=$pid
STORAGE_PATH=$storage_path
EOF
}

read_state_value() {
  local key="$1"

  if [[ ! -f "$VICTORIA_PID_PATH" ]]; then
    return 1
  fi

  awk -F= -v key="$key" '$1 == key { sub($1 FS, ""); print; exit }' "$VICTORIA_PID_PATH"
}

is_listening() {
  lsof -nP -iTCP:"$VICTORIA_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

resolve_listener_pid() {
  lsof -nP -t -iTCP:"$VICTORIA_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
}

wait_for_startup() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS "http://${VICTORIA_HOST}:${VICTORIA_PORT}/api/v1/query?query=1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_server() {
  if [[ ! -x "$VICTORIA_BINARY" ]]; then
    echo "VictoriaMetrics binary not found or not executable: $VICTORIA_BINARY" >&2
    exit 1
  fi

  if [[ -z "$VICTORIA_TSDB_PATH" ]]; then
    echo "A VictoriaMetrics storage path is required. Pass --storage-path /path/to/tsdb or set VICTORIA_TSDB_PATH." >&2
    exit 1
  fi

  if [[ ! -d "$VICTORIA_TSDB_PATH" ]]; then
    echo "VictoriaMetrics storage path does not exist: $VICTORIA_TSDB_PATH" >&2
    exit 1
  fi

  if is_listening; then
    local existing_pid
    existing_pid="$(resolve_listener_pid)"
    echo "VictoriaMetrics already listening on ${VICTORIA_HOST}:${VICTORIA_PORT} (pid ${existing_pid:-unknown})."
    return 0
  fi

  nohup "$VICTORIA_BINARY" \
    --storageDataPath="$VICTORIA_TSDB_PATH" \
    -memory.allowedPercent=10 \
    -retentionPeriod=10y \
    -search.disableCache \
    -search.latencyOffset=0 \
    -search.maxPointsPerTimeseries=90000 \
    -httpListenAddr=":${VICTORIA_PORT}" \
    >"$VICTORIA_LOG_PATH" 2>&1 &

  local pid="$!"
  write_state_file "$pid" "$VICTORIA_TSDB_PATH"

  if wait_for_startup; then
    echo "VictoriaMetrics started on ${VICTORIA_HOST}:${VICTORIA_PORT} (pid $pid)."
    echo "Log: $VICTORIA_LOG_PATH"
    return 0
  fi

  echo "VictoriaMetrics failed to become ready. Check $VICTORIA_LOG_PATH" >&2
  exit 1
}

stop_server() {
  local pid=""

  pid="$(read_state_value PID 2>/dev/null || true)"

  if [[ -z "$pid" ]]; then
    pid="$(resolve_listener_pid || true)"
  fi

  if [[ -z "$pid" ]]; then
    echo "VictoriaMetrics is not running on port ${VICTORIA_PORT}."
    rm -f "$VICTORIA_PID_PATH"
    return 0
  fi

  kill "$pid" 2>/dev/null || true

  local attempt
  for attempt in $(seq 1 20); do
    if ! is_listening; then
      rm -f "$VICTORIA_PID_PATH"
      echo "VictoriaMetrics stopped (pid $pid)."
      return 0
    fi
    sleep 0.5
  done

  echo "VictoriaMetrics did not stop cleanly. It may still be running on port ${VICTORIA_PORT}." >&2
  exit 1
}

status_server() {
  if is_listening; then
    local pid
    local storage_path
    pid="$(resolve_listener_pid)"
    storage_path="${VICTORIA_TSDB_PATH:-$(read_state_value STORAGE_PATH 2>/dev/null || true)}"
    echo "VictoriaMetrics is running on ${VICTORIA_HOST}:${VICTORIA_PORT} (pid ${pid:-unknown})."
    if [[ -n "$storage_path" ]]; then
      echo "TSDB: $storage_path"
    fi
    echo "Log: $VICTORIA_LOG_PATH"
    return 0
  fi

  echo "VictoriaMetrics is not running on ${VICTORIA_HOST}:${VICTORIA_PORT}."
  return 1
}

main() {
  local command="${1:-}"
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --storage-path)
        if [[ $# -lt 2 ]]; then
          echo "--storage-path requires a value" >&2
          exit 1
        fi
        VICTORIA_TSDB_PATH="$2"
        shift 2
        ;;
      --storage-path=*)
        VICTORIA_TSDB_PATH="${1#--storage-path=}"
        shift
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  case "$command" in
    start)
      start_server
      ;;
    stop)
      stop_server
      ;;
    status)
      status_server
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
