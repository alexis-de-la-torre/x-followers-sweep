#!/bin/bash
set -Eeuo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CHROME_CDP_PORT="${CHROME_CDP_PORT:-9223}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/chrome-profile}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

CHROME_STARTUP_TIMEOUT_SECONDS="${CHROME_STARTUP_TIMEOUT_SECONDS:-30}"
CHROME_SHUTDOWN_TIMEOUT_SECONDS="${CHROME_SHUTDOWN_TIMEOUT_SECONDS:-20}"
AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS="${AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS:-5}"
STALE_LOCK_QUIET_SECONDS="${STALE_LOCK_QUIET_SECONDS:-5}"
STALE_LOCK_WAIT_TIMEOUT_SECONDS="${STALE_LOCK_WAIT_TIMEOUT_SECONDS:-60}"
PROFILE_OWNER_CDP_URL="${PROFILE_OWNER_CDP_URL:-}"
CHROME_HEALTHCHECK_PATH="${CHROME_HEALTHCHECK_PATH:-/opt/chrome-healthcheck.py}"
PROFILE_LEASE_FILE="${PROFILE_LEASE_FILE:-$CHROME_PROFILE_DIR/.x-sweeper-profile.lock}"

CHROME_PID=""
CHROME_PROCESS_GROUP=""
CLOUDFLARE_PID=""
PROFILE_LEASE_HELD=0
SHUTTING_DOWN=0
declare -a AUXILIARY_PIDS=()
declare -a AUXILIARY_NAMES=()

log() {
    printf '[chrome-vnc] %s\n' "$*"
}

require_positive_integer() {
    local name="$1"
    local value="$2"
    if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
        log "$name must be a positive integer; received '$value'"
        return 1
    fi
}

cdp_is_ready() {
    local url="$1"
    python3 "$CHROME_HEALTHCHECK_PATH" "$url" >/dev/null 2>&1
}

acquire_profile_lease() {
    mkdir -p "$CHROME_PROFILE_DIR"
    exec 9>>"$PROFILE_LEASE_FILE"
    if ! flock -n 9; then
        log "Profile lease is already held; refusing concurrent access to $CHROME_PROFILE_DIR"
        return 1
    fi
    PROFILE_LEASE_HELD=1
    log "Acquired exclusive profile lease for $CHROME_PROFILE_DIR"
}

wait_for_foreign_owner_to_disappear() {
    local owner="$1"

    if [[ -z "$PROFILE_OWNER_CDP_URL" ]]; then
        log "Lock belongs to '$owner' and PROFILE_OWNER_CDP_URL is unset; refusing unverified recovery"
        return 1
    fi

    local deadline=$((SECONDS + STALE_LOCK_WAIT_TIMEOUT_SECONDS))
    local quiet_since=$SECONDS
    log "Waiting for '$owner' to stop serving CDP before recovering its profile lock"

    while (( SECONDS < deadline )); do
        if cdp_is_ready "$PROFILE_OWNER_CDP_URL"; then
            quiet_since=$SECONDS
        elif (( SECONDS - quiet_since >= STALE_LOCK_QUIET_SECONDS )); then
            log "No browser owner served CDP for ${STALE_LOCK_QUIET_SECONDS}s; recovery may continue"
            return 0
        fi
        sleep 1
    done

    log "A browser owner remained reachable during the ${STALE_LOCK_WAIT_TIMEOUT_SECONDS}s recovery window"
    return 1
}

recover_stale_singletons() {
    local lock_path="$CHROME_PROFILE_DIR/SingletonLock"
    local cookie_path="$CHROME_PROFILE_DIR/SingletonCookie"
    local socket_path="$CHROME_PROFILE_DIR/SingletonSocket"

    if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
        if [[ -e "$cookie_path" || -L "$cookie_path" || -e "$socket_path" || -L "$socket_path" ]]; then
            log "Removing orphaned singleton metadata after acquiring the profile lease"
            rm -f "$cookie_path" "$socket_path"
        fi
        return 0
    fi

    if [[ ! -L "$lock_path" ]]; then
        log "SingletonLock is not a symlink; refusing to modify unexpected profile data"
        return 1
    fi

    local lock_target
    lock_target="$(readlink "$lock_path")"
    if [[ ! "$lock_target" =~ ^(.+)-([0-9]+)$ ]]; then
        log "SingletonLock target '$lock_target' has an unknown format; refusing recovery"
        return 1
    fi

    local lock_host="${BASH_REMATCH[1]}"
    local lock_pid="${BASH_REMATCH[2]}"
    local current_host
    current_host="$(hostname)"

    if [[ "$lock_host" == "$current_host" ]] && process_is_running "$lock_pid"; then
        log "SingletonLock belongs to live local PID $lock_pid; refusing concurrent Chrome startup"
        return 1
    fi

    if [[ "$lock_host" != "$current_host" ]]; then
        wait_for_foreign_owner_to_disappear "$lock_host" || return 1
    fi

    log "Recovering stale Chromium singleton metadata from '$lock_target'"
    rm -f "$lock_path" "$cookie_path" "$socket_path"
}

register_auxiliary() {
    AUXILIARY_NAMES+=("$1")
    AUXILIARY_PIDS+=("$2")
}

assert_running() {
    local name="$1"
    local pid="$2"
    if ! process_is_running "$pid"; then
        log "$name exited during startup"
        return 1
    fi
}

process_is_running() {
    local pid="$1"
    local process_stat
    local process_state

    if ! kill -0 "$pid" 2>/dev/null; then
        return 1
    fi

    # kill -0 also succeeds for an unreaped zombie. Treat it as exited so the
    # PID 1 shutdown path can reap it instead of waiting for the full timeout.
    if [[ -r "/proc/$pid/stat" ]]; then
        if ! process_stat="$(<"/proc/$pid/stat")" 2>/dev/null; then
            return 1
        fi
        process_stat="${process_stat##*) }"
        process_state="${process_stat%% *}"
        if [[ "$process_state" == "Z" || "$process_state" == "X" ]]; then
            return 1
        fi
    fi

    return 0
}

process_group_is_running() {
    local expected_group="$1"
    local stat_path
    local process_stat
    local process_state
    local process_parent
    local process_group

    for stat_path in /proc/[0-9]*/stat; do
        [[ -r "$stat_path" ]] || continue
        if ! process_stat="$(<"$stat_path")" 2>/dev/null; then
            continue
        fi
        process_stat="${process_stat##*) }"
        read -r process_state process_parent process_group _ <<<"$process_stat"
        if [[ "$process_group" == "$expected_group" && "$process_state" != "Z" && "$process_state" != "X" ]]; then
            return 0
        fi
    done
    return 1
}

chrome_processes_are_running() {
    if [[ -n "$CHROME_PROCESS_GROUP" ]] && process_group_is_running "$CHROME_PROCESS_GROUP"; then
        return 0
    fi
    if [[ -n "$CHROME_PID" ]] && process_is_running "$CHROME_PID"; then
        return 0
    fi
    return 1
}

wait_for_chrome_exit() {
    local timeout_seconds="$1"
    local deadline=$((SECONDS + timeout_seconds))

    while chrome_processes_are_running; do
        if (( SECONDS >= deadline )); then
            return 1
        fi
        sleep 0.2
    done
}

signal_chrome() {
    local signal="$1"
    if [[ -n "$CHROME_PROCESS_GROUP" ]]; then
        kill "-$signal" -- "-$CHROME_PROCESS_GROUP" 2>/dev/null || true
    fi
    if [[ -n "$CHROME_PID" ]]; then
        kill "-$signal" "$CHROME_PID" 2>/dev/null || true
    fi
}

remove_singleton_metadata() {
    local lock_path="$CHROME_PROFILE_DIR/SingletonLock"
    local cookie_path="$CHROME_PROFILE_DIR/SingletonCookie"
    local socket_path="$CHROME_PROFILE_DIR/SingletonSocket"

    if [[ -e "$lock_path" || -L "$lock_path" || -e "$cookie_path" || -L "$cookie_path" || -e "$socket_path" || -L "$socket_path" ]]; then
        log "Removing Chromium singleton metadata after confirmed browser exit"
        rm -f "$lock_path" "$cookie_path" "$socket_path"
    fi
}

stop_chrome() {
    local chrome_stopped=1

    if [[ -z "$CHROME_PID" && -z "$CHROME_PROCESS_GROUP" ]]; then
        return 0
    fi

    if chrome_processes_are_running; then
        log "Stopping Chrome PID ${CHROME_PID:-unknown}"
        signal_chrome TERM
    fi

    if ! wait_for_chrome_exit "$CHROME_SHUTDOWN_TIMEOUT_SECONDS"; then
        log "Chrome did not exit within ${CHROME_SHUTDOWN_TIMEOUT_SECONDS}s; sending SIGKILL"
        signal_chrome KILL
        if ! wait_for_chrome_exit "$AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS"; then
            log "Chrome processes remain after SIGKILL; preserving singleton metadata"
            chrome_stopped=0
        fi
    fi

    if (( chrome_stopped )) && [[ -n "$CHROME_PID" ]]; then
        wait "$CHROME_PID" 2>/dev/null || true
    fi
    CHROME_PID=""
    CHROME_PROCESS_GROUP=""

    if (( chrome_stopped && PROFILE_LEASE_HELD )); then
        remove_singleton_metadata
    fi
}

stop_auxiliaries() {
    local index
    local pid
    local name
    local any_running
    local deadline=$((SECONDS + AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS))

    for ((index=${#AUXILIARY_PIDS[@]} - 1; index >= 0; index--)); do
        pid="${AUXILIARY_PIDS[$index]}"
        name="${AUXILIARY_NAMES[$index]}"
        if process_is_running "$pid"; then
            log "Stopping $name PID $pid"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    while (( SECONDS < deadline )); do
        any_running=0
        for pid in "${AUXILIARY_PIDS[@]}"; do
            if process_is_running "$pid"; then
                any_running=1
                break
            fi
        done
        if (( ! any_running )); then
            break
        fi
        sleep 0.2
    done

    for ((index=${#AUXILIARY_PIDS[@]} - 1; index >= 0; index--)); do
        pid="${AUXILIARY_PIDS[$index]}"
        name="${AUXILIARY_NAMES[$index]}"
        if process_is_running "$pid"; then
            log "$name did not exit within the shared ${AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS}s window; sending SIGKILL"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done

    for pid in "${AUXILIARY_PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    AUXILIARY_PIDS=()
    AUXILIARY_NAMES=()
}

release_profile_lease() {
    if (( PROFILE_LEASE_HELD )); then
        flock -u 9 || true
        exec 9>&-
        PROFILE_LEASE_HELD=0
        log "Released profile lease"
    fi
}

shutdown() {
    if (( SHUTTING_DOWN )); then
        return 0
    fi
    SHUTTING_DOWN=1
    trap - TERM INT
    stop_chrome
    stop_auxiliaries
    release_profile_lease
}

handle_signal() {
    local signal="$1"
    log "Received $signal; beginning graceful shutdown"
    shutdown
    exit 0
}

wait_for_chrome_startup() {
    local deadline=$((SECONDS + CHROME_STARTUP_TIMEOUT_SECONDS))
    local url="http://127.0.0.1:$CHROME_CDP_PORT/json/version"

    while (( SECONDS < deadline )); do
        if ! process_is_running "$CHROME_PID"; then
            log "Chrome exited before CDP became available"
            return 1
        fi
        if cdp_is_ready "$url"; then
            log "Chrome ready (PID: $CHROME_PID, CDP on :$CHROME_CDP_PORT)"
            return 0
        fi
        sleep 1
    done

    log "Chrome did not expose a valid CDP endpoint within ${CHROME_STARTUP_TIMEOUT_SECONDS}s"
    return 1
}

start_desktop_and_proxy() {
    log "[1] Starting Xvfb"
    Xvfb :99 -screen 0 414x896x24 9>&- &
    register_auxiliary "Xvfb" "$!"
    sleep 1
    assert_running "Xvfb" "${AUXILIARY_PIDS[-1]}"

    log "[2] Starting Fluxbox"
    fluxbox 9>&- &
    register_auxiliary "Fluxbox" "$!"
    sleep 1
    assert_running "Fluxbox" "${AUXILIARY_PIDS[-1]}"

    log "[3] Starting x11vnc"
    x11vnc -display :99 -forever -shared -rfbport "$VNC_PORT" -nopw -quiet 9>&- &
    register_auxiliary "x11vnc" "$!"
    sleep 1
    assert_running "x11vnc" "${AUXILIARY_PIDS[-1]}"

    log "[4] Starting noVNC"
    /opt/noVNC/utils/novnc_proxy \
        --vnc "localhost:$VNC_PORT" \
        --listen "$NOVNC_PORT" \
        --web /opt/noVNC \
        > /tmp/novnc.log 2>&1 9>&- &
    register_auxiliary "noVNC" "$!"
    sleep 2
    assert_running "noVNC" "${AUXILIARY_PIDS[-1]}"

    # Chrome binds CDP to loopback. The proxy exposes it to the cluster.
    log "[5] Starting CDP proxy on 0.0.0.0:$CDP_PORT -> 127.0.0.1:$CHROME_CDP_PORT"
    python3 /opt/cdp-proxy.py "$CDP_PORT" "$CHROME_CDP_PORT" 9>&- &
    register_auxiliary "CDP proxy" "$!"
    sleep 1
    assert_running "CDP proxy" "${AUXILIARY_PIDS[-1]}"
}

start_chrome() {
    log "[6] Starting Chrome on port $CHROME_CDP_PORT"
    setsid google-chrome-stable \
        --disable-gpu \
        --no-sandbox \
        --disable-dev-shm-usage \
        --disable-software-rasterizer \
        --no-first-run \
        --password-store=basic \
        --remote-debugging-port="$CHROME_CDP_PORT" \
        --user-data-dir="$CHROME_PROFILE_DIR" \
        --window-size=414,896 \
        https://x.com/login \
        9>&- &
    CHROME_PID=$!
    CHROME_PROCESS_GROUP="$CHROME_PID"
    wait_for_chrome_startup
}

start_cloudflared() {
    log "[7] Starting cloudflared tunnel"
    : > /tmp/cloudflared.log
    cloudflared tunnel --url "http://localhost:$NOVNC_PORT" > /tmp/cloudflared.log 2>&1 9>&- &
    CLOUDFLARE_PID=$!
    register_auxiliary "cloudflared" "$CLOUDFLARE_PID"

    local tunnel_url=""
    local attempt
    for attempt in $(seq 1 15); do
        sleep 1
        tunnel_url="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1 || true)"
        if [[ -n "$tunnel_url" ]]; then
            log "Cloudflare tunnel: $tunnel_url"
            break
        fi
        if ! process_is_running "$CLOUDFLARE_PID"; then
            log "cloudflared exited before publishing a tunnel URL"
            break
        fi
    done

    if [[ -z "$tunnel_url" ]]; then
        log "Cloudflare tunnel URL is unavailable; Chrome remains available through the cluster"
    fi
}

monitor_chrome() {
    local status=0
    wait "$CHROME_PID" || status=$?
    log "Chrome exited unexpectedly (status $status); failing the container"
    return 1
}

main() {
    require_positive_integer CHROME_STARTUP_TIMEOUT_SECONDS "$CHROME_STARTUP_TIMEOUT_SECONDS"
    require_positive_integer CHROME_SHUTDOWN_TIMEOUT_SECONDS "$CHROME_SHUTDOWN_TIMEOUT_SECONDS"
    require_positive_integer AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS "$AUXILIARY_SHUTDOWN_TIMEOUT_SECONDS"
    require_positive_integer STALE_LOCK_QUIET_SECONDS "$STALE_LOCK_QUIET_SECONDS"
    require_positive_integer STALE_LOCK_WAIT_TIMEOUT_SECONDS "$STALE_LOCK_WAIT_TIMEOUT_SECONDS"

    trap 'handle_signal TERM' TERM
    trap 'handle_signal INT' INT
    trap shutdown EXIT

    log "=============================================="
    log "X Followers Sweep — Chrome + VNC"
    log "CDP: port $CDP_PORT (proxy) -> localhost:$CHROME_CDP_PORT (Chrome)"
    log "VNC: port $VNC_PORT; noVNC: port $NOVNC_PORT"

    acquire_profile_lease
    recover_stale_singletons
    start_desktop_and_proxy
    start_chrome
    start_cloudflared

    log "Ready. Chrome, CDP proxy, VNC, and noVNC are running"
    monitor_chrome
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
