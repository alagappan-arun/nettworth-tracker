#!/bin/bash
# Sets up http://myfinance.local (no port) as an alias for localhost:3000.
# Run once: sudo npm run setup-domain
# Safe to re-run — all steps are idempotent.
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo:  sudo npm run setup-domain"
  exit 1
fi

HOSTNAME="myfinance.local"
PORT=3000
ANCHOR_NAME="com.myfinance"
ANCHOR_FILE="/etc/pf.anchors/${ANCHOR_NAME}"
PF_CONF="/etc/pf.conf"

# ── 1. /etc/hosts ─────────────────────────────────────────────────────────────
if grep -q "${HOSTNAME}" /etc/hosts; then
  echo "  ✓ /etc/hosts already has ${HOSTNAME}"
else
  echo "127.0.0.1 ${HOSTNAME}" >> /etc/hosts
  echo "  ✓ Added ${HOSTNAME} → 127.0.0.1 in /etc/hosts"
fi

# ── 2. pf anchor file (redirect 80 → PORT) ───────────────────────────────────
cat > "${ANCHOR_FILE}" << EOF
rdr pass on lo0 proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${PORT}
EOF
echo "  ✓ Created pf anchor ${ANCHOR_FILE}"

# ── 3. Reference anchor in pf.conf (once) ────────────────────────────────────
if grep -q "${ANCHOR_NAME}" "${PF_CONF}"; then
  echo "  ✓ pf.conf already references ${ANCHOR_NAME}"
else
  cp "${PF_CONF}" "${PF_CONF}.bak"
  # Insert rdr-anchor line after the existing rdr-anchor "com.apple/*" line
  sed -i '' "s|rdr-anchor \"com.apple/\*\"|rdr-anchor \"com.apple/*\"\nrdr-anchor \"${ANCHOR_NAME}\"|" "${PF_CONF}"
  # Append the load-anchor line at the end
  echo "load anchor \"${ANCHOR_NAME}\" from \"${ANCHOR_FILE}\"" >> "${PF_CONF}"
  echo "  ✓ Updated pf.conf (backup saved to pf.conf.bak)"
fi

# ── 4. LaunchDaemon — reloads our anchor on every boot ───────────────────────
PLIST="/Library/LaunchDaemons/${ANCHOR_NAME}.portredirect.plist"
cat > "${PLIST}" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ANCHOR_NAME}.portredirect</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/sbin/pfctl</string>
    <string>-f</string>
    <string>${PF_CONF}</string>
  </array>
</dict>
</plist>
EOF
launchctl load "${PLIST}" 2>/dev/null || true
echo "  ✓ Installed LaunchDaemon for boot persistence"

# ── 5. Activate now ───────────────────────────────────────────────────────────
pfctl -f "${PF_CONF}" 2>/dev/null && pfctl -E 2>/dev/null || true
echo ""
echo "  All done!  Open http://${HOSTNAME}"
