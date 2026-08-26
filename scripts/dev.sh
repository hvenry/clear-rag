#!/usr/bin/env bash
#
# Start the development stack: backend with auto-reload, frontend with HMR.
#
# Everything here exists because a dev server that half-starts is worse than one that
# refuses to. Vite prints its ready banner and proxies /api whether or not uvicorn came
# up, so a backend that died at boot does not look like a dead backend -- it looks like
# a broken app, or worse, like a working one serving another process's 404s.
#
# So: every check below runs BEFORE Vite is allowed to paint over the evidence, and the
# backend must actually answer a request before the terminal is handed to the frontend.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
    BOLD=''; RED=''; YELLOW=''; GREEN=''; DIM=''; OFF=''
fi

step() { printf '%s->%s %s\n' "$DIM" "$OFF" "$1"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%serror%s %s\n' "$RED" "$OFF" "$1" >&2; [[ $# -gt 1 ]] && printf '%s\n' "$2" >&2; exit 1; }

sha_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else sha256sum "$1" | cut -d' ' -f1; fi
}

# ── 1. The virtualenv exists ────────────────────────────────────────────────────
# `clear-rag` is a console script inside .venv/bin. It is never on PATH unless the venv
# is activated, which is why every Makefile target spells the path out in full.
[[ -x .venv/bin/clear-rag ]] || die "no virtualenv at .venv (or it has no clear-rag)." \
    "  Run: make install"

# ── 2. The virtualenv matches pyproject.toml ────────────────────────────────────
# Dependency drift is silent: a package added to pyproject.toml after the venv was built
# is simply absent, and the features that need it degrade rather than crash. Stamping the
# file's hash at install time turns that into something a shell comparison can notice.
stamp=".venv/.deps-stamp"
want="$(sha_of pyproject.toml)"
if [[ ! -f $stamp || "$(cat "$stamp")" != "$want" ]]; then
    step "pyproject.toml changed since the last install -- syncing dependencies"
    .venv/bin/pip install -q --disable-pip-version-check -e ".[dev]"
    printf '%s\n' "$want" > "$stamp"
fi

# ── 3. Web dependencies exist ───────────────────────────────────────────────────
if [[ ! -d web/node_modules ]]; then
    step "installing web dependencies"
    (cd web && npm install)
fi

# ── 4. Resolve the port from Settings, not from a literal ───────────────────────
# Asking the application for its own port is the only way to be certain this script, the
# Vite proxy and uvicorn agree. Anything else is a fourth copy of the number.
read -r PORT OLLAMA_URL < <(.venv/bin/python -c \
    "from clearrag.config import get_settings as s; c = s(); print(c.port, c.ollama_url)")

# ── 5. The port is free ─────────────────────────────────────────────────────────
if holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1, $2}')" \
   && [[ -n $holder ]]; then
    name="${holder%% *}"; pid="${holder##* }"
    hint="  Free it:  kill $pid"
    # Docker publishes ports through its own proxy, so the listening process is Docker
    # itself and the pid is useless -- the container name is what you actually need.
    if [[ $name == com.docke* || $name == docker* ]]; then
        container="$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ":$PORT->" | cut -f1 || true)"
        hint="  Free it:  docker stop ${container:-<the container publishing :$PORT>}"
    elif [[ $name == Python* || $name == python* ]]; then
        hint="  That looks like a stray clear-rag from an earlier run."$'\n'"  Free it:  kill $pid"
    fi
    die "port $PORT is already in use by $name (pid $pid)." \
        "$hint"$'\n'"  Or pick another:  CLEARRAG_PORT=8011 make dev"
fi

# ── 6. Ollama is reachable (a warning, never fatal) ─────────────────────────────
# The UI loads and documents index without a model; only answering needs one. Refusing to
# start would be a worse trade than saying so and carrying on.
if ! curl -sf -m 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    warn "Ollama is not answering at $OLLAMA_URL -- ingestion and answers will fail."
    warn "Start it with 'ollama serve', then check with 'make check'."
fi

# ── 7. Backend first, and prove it came up ──────────────────────────────────────
# `set -m` puts the backend in its own process group, so the trap can kill it and every
# uvicorn reload child without signalling this script, make, or the user's shell.
set -m
.venv/bin/clear-rag serve --reload --no-browser &
backend=$!
set +m
trap 'kill -- -$backend 2>/dev/null || true' EXIT INT TERM

step "waiting for the backend on :$PORT"
for _ in $(seq 1 60); do
    if curl -sf -m 1 "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
        ready=1; break
    fi
    # A backend that exited is never going to answer; fail now rather than after 30s.
    kill -0 "$backend" 2>/dev/null || die "the backend exited during startup (see the log above)."
    sleep 0.5
done
[[ ${ready:-} == 1 ]] || die "the backend never answered on :$PORT after 30s."

printf '\n%s  backend%s  http://127.0.0.1:%s  %s(reload)%s\n' "$GREEN" "$OFF" "$PORT" "$DIM" "$OFF"
printf '%s  UI     %s  http://localhost:5173 %s(open this one)%s\n\n' "$GREEN" "$OFF" "$DIM" "$OFF"

# ── 8. Frontend in the foreground; its exit tears the backend down ──────────────
cd web && npm run dev
