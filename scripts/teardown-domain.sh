#!/bin/bash
# Removes the myfinance.local setup.
# Run once: sudo npm run teardown-domain
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo:  sudo npm run teardown-domain"
  exit 1
fi

HOSTNAME="myfinance.local"
ANCHOR_NAME="com.myfinance"
ANCHOR_FILE="/etc/pf.anchors/${ANCHOR_NAME}"
PF_CONF="/etc/pf.conf"
PLIST="/Library/LaunchDaemons/${ANCHOR_NAME}.portredirect.plist"

# Remove from /etc/hosts
sed -i '' "/127.0.0.1 ${HOSTNAME}/d" /etc/hosts && echo "  ✓ Removed ${HOSTNAME} from /etc/hosts"

# Remove anchor references from pf.conf
sed -i '' "/rdr-anchor \"${ANCHOR_NAME}\"/d" "${PF_CONF}"
sed -i '' "/load anchor \"${ANCHOR_NAME}\"/d" "${PF_CONF}"
echo "  ✓ Removed anchor from pf.conf"

# Remove anchor file
rm -f "${ANCHOR_FILE}" && echo "  ✓ Removed ${ANCHOR_FILE}"

# Unload and remove LaunchDaemon
launchctl unload "${PLIST}" 2>/dev/null || true
rm -f "${PLIST}" && echo "  ✓ Removed LaunchDaemon"

# Reload pf without our rule
pfctl -f "${PF_CONF}" 2>/dev/null || true

echo ""
echo "  Done. Use http://localhost:3000 to access the app."
