#!/bin/bash
# ==============================================================================
# init-setup.sh — One-shot initialization for claude-code-ssh container
# Runs via s6-overlay oneshot before any services start.
# Idempotent: safe to run on every container restart.
# ==============================================================================
set -e

# ------------------------------------------------------------------------------
# Import container environment variables from s6-overlay
# s6-overlay stores Docker env vars in /var/run/s6/container_environment/
# Oneshot scripts do NOT inherit them automatically.
# ------------------------------------------------------------------------------
if [ -d /var/run/s6/container_environment ]; then
    for envfile in /var/run/s6/container_environment/*; do
        if [ -f "$envfile" ]; then
            varname="$(basename "$envfile")"
            # Skip s6-internal variables
            case "$varname" in S6_*|s6-*) continue ;; esac
            export "$varname"="$(cat "$envfile")"
        fi
    done
fi

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------
log() { echo ">>> $*"; }
warn() { echo "!!! WARNING: $*" >&2; }
die() { echo "!!! ERROR: $*" >&2; exit 1; }

CLAUDE_USER="claude"
CLAUDE_HOME="/home/${CLAUDE_USER}"
DATA_DIR="/data"
DATA_HOME="${DATA_DIR}/home"
DATA_SSH_KEYS="${DATA_DIR}/ssh_host_keys"
DATA_FAIL2BAN="${DATA_DIR}/fail2ban"
DATA_WORKSPACE="${DATA_DIR}/workspace"
DATA_WEB_UI="${DATA_DIR}/web-ui"

# ==============================================================================
# Step 1: Volume directory initialization
# ==============================================================================
log "Initializing volume directories under ${DATA_DIR}..."

for dir in "${DATA_HOME}" "${DATA_SSH_KEYS}" "${DATA_FAIL2BAN}" "${DATA_WORKSPACE}" "${DATA_WEB_UI}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        log "  Created $dir"
    fi
done

# Ownership: claude owns the mount root plus user-facing app/workspace data;
# root owns security-sensitive service stores.
chown "${CLAUDE_USER}:${CLAUDE_USER}" "${DATA_DIR}" "${DATA_HOME}" "${DATA_WORKSPACE}" "${DATA_WEB_UI}"
chown root:root "${DATA_SSH_KEYS}" "${DATA_FAIL2BAN}"

# ==============================================================================
# Step 2: SSH host key persistence
# ==============================================================================
log "Configuring SSH host keys..."

# Remove weak key types unconditionally
rm -f /etc/ssh/ssh_host_dsa_key*    /etc/ssh/ssh_host_dsa_key*.pub
rm -f /etc/ssh/ssh_host_ecdsa_key*  /etc/ssh/ssh_host_ecdsa_key*.pub

if [ -f "${DATA_SSH_KEYS}/ssh_host_ed25519_key" ] && \
   [ -f "${DATA_SSH_KEYS}/ssh_host_rsa_key" ]; then
    # Restore persisted keys
    log "  Restoring persisted host keys from ${DATA_SSH_KEYS}..."
    cp -f "${DATA_SSH_KEYS}"/ssh_host_*_key     /etc/ssh/
    cp -f "${DATA_SSH_KEYS}"/ssh_host_*_key.pub  /etc/ssh/
else
    # Remove any existing keys first to avoid overwrite prompts
    rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub
    rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub

    # Generate new keys
    log "  Generating new Ed25519 host key..."
    ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N ""

    log "  Generating new RSA-4096 host key..."
    ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_rsa_key -N ""

    # Persist for next restart
    log "  Persisting host keys to ${DATA_SSH_KEYS}..."
    cp -f /etc/ssh/ssh_host_*_key     "${DATA_SSH_KEYS}/"
    cp -f /etc/ssh/ssh_host_*_key.pub "${DATA_SSH_KEYS}/"
fi

# Enforce correct permissions
chmod 600 /etc/ssh/ssh_host_*_key
chmod 644 /etc/ssh/ssh_host_*_key.pub
chmod 600 "${DATA_SSH_KEYS}"/ssh_host_*_key     2>/dev/null || true
chmod 644 "${DATA_SSH_KEYS}"/ssh_host_*_key.pub  2>/dev/null || true

# ==============================================================================
# Step 3: DH moduli filtering (keep only >= 3071-bit entries)
# ==============================================================================
if [ -f /etc/ssh/moduli ]; then
    MODULI_LINES=$(wc -l < /etc/ssh/moduli)
    # Only filter if file has more lines than a filtered version would
    # (i.e., there are still weak entries present)
    SAFE_LINES=$(awk '$5 >= 3071' /etc/ssh/moduli | wc -l)
    if [ "$MODULI_LINES" -ne "$SAFE_LINES" ]; then
        log "Filtering DH moduli (keeping >= 3071-bit entries)..."
        awk '$5 >= 3071' /etc/ssh/moduli > /etc/ssh/moduli.safe
        mv /etc/ssh/moduli.safe /etc/ssh/moduli
        log "  Reduced from ${MODULI_LINES} to ${SAFE_LINES} entries."
    else
        log "DH moduli already filtered (${SAFE_LINES} entries). Skipping."
    fi
fi

# ==============================================================================
# Step 4: Home directory persistence (change home to /data/home)
# Must happen BEFORE SSH key setup so keys go in the right place.
# ==============================================================================
log "Setting up persistent home directory..."

# If /data/home is empty (first run), seed it from /etc/skel + existing home
if [ ! -f "${DATA_HOME}/.bashrc" ]; then
    log "  First run detected. Seeding ${DATA_HOME} from /etc/skel..."
    cp -a /etc/skel/. "${DATA_HOME}/"
    # Merge any files from the original /home/claude (created by useradd -m)
    if [ -d "${CLAUDE_HOME}" ] && [ ! -L "${CLAUDE_HOME}" ]; then
        cp -a --no-clobber "${CLAUDE_HOME}/." "${DATA_HOME}/" 2>/dev/null || true
    fi
fi

# Always ensure Claude Code binary is up to date in persistent home.
# The native install lives in /home/claude/.local/ (build-time home).
# On rebuild, the version may change, breaking existing symlinks.
BUILD_HOME="/home/${CLAUDE_USER}"
if [ -d "${BUILD_HOME}/.local/share/claude" ]; then
    BUILD_VER="$(readlink "${BUILD_HOME}/.local/bin/claude" 2>/dev/null || echo "")"
    DATA_VER="$(readlink "${DATA_HOME}/.local/bin/claude" 2>/dev/null || echo "")"
    if [ "$BUILD_VER" != "$DATA_VER" ] || [ ! -x "${DATA_HOME}/.local/bin/claude" ]; then
        log "  Syncing Claude Code installation to ${DATA_HOME}/.local/..."
        mkdir -p "${DATA_HOME}/.local/bin" "${DATA_HOME}/.local/share"
        # Force-copy bin and share to update symlinks and version files
        cp -af "${BUILD_HOME}/.local/bin/." "${DATA_HOME}/.local/bin/"
        cp -af "${BUILD_HOME}/.local/share/claude" "${DATA_HOME}/.local/share/"
        chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "${DATA_HOME}/.local"
        log "  Claude Code updated: $(readlink "${DATA_HOME}/.local/bin/claude")"
    else
        log "  Claude Code already up to date."
    fi
fi

# Ensure ~/.local/bin is in PATH and UTF-8 locale for all shell types
BASHRC="${DATA_HOME}/.bashrc"
if [ -f "${BASHRC}" ] && ! grep -q '\.local/bin' "${BASHRC}"; then
    cat >> "${BASHRC}" <<'BASHRC_APPEND'
export PATH="$HOME/.local/bin:$PATH"
export LANG=en_US.UTF-8
export LANGUAGE=en_US:en
export LC_ALL=en_US.UTF-8
BASHRC_APPEND
    log "  Added PATH and UTF-8 locale to .bashrc"
fi

# Change the user's home directory to /data/home
# This avoids symlink ownership issues with sshd StrictModes
if [ "$(getent passwd ${CLAUDE_USER} | cut -d: -f6)" != "${DATA_HOME}" ]; then
    usermod -d "${DATA_HOME}" "${CLAUDE_USER}"
    log "  Changed ${CLAUDE_USER} home to ${DATA_HOME}"
fi

# Update our variable to reflect the actual home
CLAUDE_HOME="${DATA_HOME}"

# Ensure correct ownership
chown "${CLAUDE_USER}:${CLAUDE_USER}" "${DATA_HOME}"

# ==============================================================================
# Step 5: User SSH key setup (uses updated CLAUDE_HOME = /data/home)
# ==============================================================================
log "Configuring user SSH authorized keys..."

if [ -z "${SSH_PUBLIC_KEY:-}" ]; then
    die "SSH_PUBLIC_KEY environment variable is not set. Cannot configure SSH access."
fi

SSH_DIR="${CLAUDE_HOME}/.ssh"
AUTHORIZED_KEYS="${SSH_DIR}/authorized_keys"

mkdir -p "${SSH_DIR}"
chmod 700 "${SSH_DIR}"

# Environment variable is the source of truth -- always overwrite
printf '%s\n' "${SSH_PUBLIC_KEY}" > "${AUTHORIZED_KEYS}"
chmod 600 "${AUTHORIZED_KEYS}"
chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "${SSH_DIR}"

log "  Wrote authorized_keys to ${AUTHORIZED_KEYS} ($(wc -l < "${AUTHORIZED_KEYS}") key(s))."

# ==============================================================================
# Step 6: Workspace directory
# ==============================================================================
log "Setting up workspace..."

if [ ! -L /workspace ] || [ "$(readlink /workspace)" != "${DATA_WORKSPACE}" ]; then
    rm -rf /workspace 2>/dev/null || true
    ln -sfn "${DATA_WORKSPACE}" /workspace
    log "  Symlinked /workspace -> ${DATA_WORKSPACE}"
else
    log "  Workspace symlink already correct."
fi

chown "${CLAUDE_USER}:${CLAUDE_USER}" "${DATA_WORKSPACE}"

# ==============================================================================
# Step 7: fail2ban persistence
# ==============================================================================
log "Configuring fail2ban persistence..."

mkdir -p /var/lib/fail2ban

if [ -f "${DATA_FAIL2BAN}/fail2ban.sqlite3" ]; then
    log "  Restoring fail2ban database from ${DATA_FAIL2BAN}..."
    cp -f "${DATA_FAIL2BAN}/fail2ban.sqlite3" /var/lib/fail2ban/fail2ban.sqlite3
fi

# Create a cron-like sync script for runtime persistence
# (s6 finish scripts or a periodic task will call this)
cat > /usr/local/bin/persist-fail2ban <<'SCRIPT'
#!/bin/bash
# Sync fail2ban database back to persistent storage
if [ -f /var/lib/fail2ban/fail2ban.sqlite3 ]; then
    cp -f /var/lib/fail2ban/fail2ban.sqlite3 /data/fail2ban/fail2ban.sqlite3
fi
SCRIPT
chmod +x /usr/local/bin/persist-fail2ban

# ==============================================================================
# Step 8: Logging and runtime directories
# ==============================================================================
log "Preparing logging and runtime directories..."

# auth.log is required by rsyslog and fail2ban
touch /var/log/auth.log
chmod 640 /var/log/auth.log

# sshd privilege separation directory
mkdir -p /var/run/sshd

# ==============================================================================
# Step 9: Environment and application config
# ==============================================================================
log "Configuring environment..."

# Anthropic API key for Claude Code
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    CLAUDE_CONFIG_DIR="${CLAUDE_HOME}/.claude"
    mkdir -p "${CLAUDE_CONFIG_DIR}"

    # Write a JSON settings file that Claude Code reads
    cat > "${CLAUDE_CONFIG_DIR}/.env" <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
EOF
    chmod 600 "${CLAUDE_CONFIG_DIR}/.env"
    chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "${CLAUDE_CONFIG_DIR}"
    log "  ANTHROPIC_API_KEY configured."

    # Also export in .bashrc so SSH sessions have access
    # (sshd does not propagate Docker env vars to user sessions)
    BASHRC="${CLAUDE_HOME}/.bashrc"
    if [ -f "${BASHRC}" ]; then
        # Remove any existing ANTHROPIC_API_KEY export to avoid duplicates
        sed -i '/^export ANTHROPIC_API_KEY=/d' "${BASHRC}"
    fi
    echo "export ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> "${BASHRC}"
    chown "${CLAUDE_USER}:${CLAUDE_USER}" "${BASHRC}"
else
    warn "ANTHROPIC_API_KEY not set. Claude Code will require manual auth."
fi

# Timezone
if [ -n "${TZ:-}" ]; then
    # Sanitize TZ: only allow alphanumeric, /, _, -
    if echo "${TZ}" | grep -qE '^[a-zA-Z0-9/_-]+$'; then
        if [ -f "/usr/share/zoneinfo/${TZ}" ]; then
            ln -sfn "/usr/share/zoneinfo/${TZ}" /etc/localtime
            echo "${TZ}" > /etc/timezone
            log "  Timezone set to ${TZ}."
        else
            warn "Invalid timezone '${TZ}'. Keeping default."
        fi
    else
        warn "Invalid timezone format '${TZ}'. Keeping default."
    fi
fi

# ==============================================================================
# Step 10: GitHub access (fine-grained PAT or gh CLI)
# ==============================================================================
log "Configuring GitHub access..."

if [ -n "${GITHUB_TOKEN:-}" ]; then
    # Fine-grained PAT provided — configure git to use it for HTTPS clones.
    # This is the recommended method: scoped to specific repos only.
    su -s /bin/bash "${CLAUDE_USER}" -c "
        git config --global url.\"https://oauth2:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"
    "
    # Also configure gh CLI to use the token (for 'gh repo clone', 'gh pr', etc.)
    BASHRC="${CLAUDE_HOME}/.bashrc"
    if [ -f "${BASHRC}" ]; then
        sed -i '/^export GITHUB_TOKEN=/d' "${BASHRC}"
    fi
    echo "export GITHUB_TOKEN=${GITHUB_TOKEN}" >> "${BASHRC}"
    chown "${CLAUDE_USER}:${CLAUDE_USER}" "${BASHRC}"
    log "  GITHUB_TOKEN configured (fine-grained PAT)."
else
    # No token — set up gh CLI as credential helper for manual 'gh auth login'
    su -s /bin/bash "${CLAUDE_USER}" -c '
        git config --global credential.https://github.com.helper "!/usr/bin/gh auth git-credential"
        git config --global credential.https://gist.github.com.helper "!/usr/bin/gh auth git-credential"
    ' 2>/dev/null
    log "  Git credential helper configured (gh auth). Run 'gh auth login' to authenticate."
fi

# ==============================================================================
# Step 11: Node.js and pnpm version overrides
# ==============================================================================
CURRENT_NODE="$(node --version 2>/dev/null | tr -d 'v')"

if [ -n "${NODE_VERSION:-}" ] && [ "$NODE_VERSION" != "$CURRENT_NODE" ]; then
    log "Switching Node.js from v${CURRENT_NODE} to v${NODE_VERSION}..."
    n "$NODE_VERSION" || warn "Failed to install Node.js v${NODE_VERSION}"
    log "  Node.js now $(node --version)"
fi

if [ -n "${PNPM_VERSION:-}" ]; then
    CURRENT_PNPM="$(pnpm --version 2>/dev/null)"
    if [ "$PNPM_VERSION" != "$CURRENT_PNPM" ]; then
        log "Switching pnpm from v${CURRENT_PNPM} to v${PNPM_VERSION}..."
        npm install -g "pnpm@${PNPM_VERSION}" --loglevel=warn \
            || warn "Failed to install pnpm v${PNPM_VERSION}"
        log "  pnpm now $(pnpm --version 2>/dev/null)"
    fi
fi

# ==============================================================================
# Step 11: Web UI configuration
# ==============================================================================
log "Configuring web UI..."

# Create web-ui subdirectories
for web_dir in uploads sessions audio; do
    mkdir -p "${DATA_WEB_UI}/${web_dir}"
    log "  Created ${DATA_WEB_UI}/${web_dir}"
done

# Create .env file for web UI backend
WEB_UI_ENV="${DATA_WEB_UI}/.env"
if [ ! -f "${WEB_UI_ENV}" ]; then
    cat > "${WEB_UI_ENV}" <<'EOF'
# Claude SSH Web UI Configuration

# Optional: Set a password to protect the web interface
# WEB_UI_PASSWORD=your-secure-password-here

# Optional: Custom workspace (defaults to /workspace)
# CLAUDE_WORKSPACE=/workspace

# Optional: Deepgram Voice Agent
# DEEPGRAM_API_KEY=your-deepgram-api-key
# DEEPGRAM_VOICE_AGENT_URL=wss://api.eu.deepgram.com/v1/agent/converse
# DEEPGRAM_LISTEN_MODEL=nova-3
# DEEPGRAM_THINK_PROVIDER=open_ai
# DEEPGRAM_THINK_MODEL=gpt-4o-mini
# DEEPGRAM_SPEAK_MODEL=aura-2-thalia-en

# Debug mode (disable in production)
DEBUG=false
EOF
    log "  Created ${WEB_UI_ENV}"
else
    log "  ${WEB_UI_ENV} already exists"
fi

# s6 services do not reliably inherit the Railway/container environment.
# Keep the web backend's persistent env file synced with runtime variables.
sync_web_ui_env_var() {
    local name="$1"
    local value="${!name:-}"

    # Accept values pasted with shell-style wrapping quotes in Railway.
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac

    sed -i "/^${name}=/d" "${WEB_UI_ENV}"
    if [ -n "$value" ]; then
        local escaped
        escaped="$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g')"
        printf '%s="%s"\n' "$name" "$escaped" >> "${WEB_UI_ENV}"
        log "  Synced ${name} to web UI env"
    fi
}

for env_name in \
    RAILWAY_PUBLIC_DOMAIN \
    WEB_UI_PASSWORD \
    SECRET_KEY \
    CLAUDE_WORKSPACE \
    CLAUDE_BINARY \
    WEB_UI_DATA_DIR \
    DATA_VOLUME_DIR \
    FRONTEND_BUILD_PATH \
    SKILLS_ROOTS \
    MCP_CONFIG_PATHS \
    DEEPGRAM_API_KEY \
    DEEPGRAM_VOICE_AGENT_URL \
    DEEPGRAM_LISTEN_MODEL \
    DEEPGRAM_THINK_PROVIDER \
    DEEPGRAM_THINK_MODEL \
    DEEPGRAM_SPEAK_MODEL \
    DEEPGRAM_VOICE_SAMPLE_RATE \
    DEEPGRAM_VOICE_PROMPT \
    DEEPGRAM_VOICE_GREETING; do
    sync_web_ui_env_var "$env_name"
done

# Set proper permissions. The web UI runs as the claude user so the backend can
# write its SQLite database and use the same Claude Code home/auth as SSH.
chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "${DATA_WEB_UI}"
chmod 755 "${DATA_WEB_UI}"
chmod 700 "${DATA_WEB_UI}/uploads" "${DATA_WEB_UI}/sessions" "${DATA_WEB_UI}/audio"
chmod 600 "${WEB_UI_ENV}"

log "  Web UI configuration complete"

# ==============================================================================
# Done
# ==============================================================================
log "Initialization complete."
exit 0
