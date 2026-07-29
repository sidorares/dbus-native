#!/bin/bash
# Bring up a system bus, a session bus, and as much of a desktop as will run
# inside a container; then exec whatever we were asked to run.
#
# Nothing here is fatal: a service that will not start in a container (no
# hardware, no udev, no kernel netlink) is reported and skipped, and the tests
# check what is actually on the bus rather than what we hoped for.
set -u

log() { echo "[services] $*"; }

mkdir -p /run/dbus /var/run/dbus

log "system bus"
dbus-daemon --system --fork --print-pid
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/var/run/dbus/system_bus_socket

log "X (dunst and the portals want a display)"
Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99

log "session bus"
eval "$(dbus-daemon --session --print-address=1 --fork --print-pid=1 | {
  read -r addr; read -r pid
  echo "export DBUS_SESSION_BUS_ADDRESS=$addr; export DBUS_SESSION_PID=$pid"
})"
log "  ${DBUS_SESSION_BUS_ADDRESS}"

start() {
  local name="$1"; shift
  if ! command -v "${1}" >/dev/null 2>&1; then
    log "  $name: not installed"
    return
  fi
  "$@" >"/tmp/$name.log" 2>&1 &
  log "  $name: started (pid $!)"
}

log "system services"
start polkitd     /usr/lib/policykit-1/polkitd --no-debug
start upowerd     /usr/libexec/upowerd
start accounts    /usr/libexec/accounts-daemon
start avahi       avahi-daemon --no-drop-root --no-chroot
start udisksd     /usr/libexec/udisks2/udisksd --no-debug
start nm          /usr/sbin/NetworkManager --no-daemon

log "session services"
start dunst       dunst

# Give the daemons a moment to claim their names.
sleep "${SERVICE_SETTLE_SECONDS:-4}"

log "system bus names:"
busctl --system list --no-pager --no-legend 2>/dev/null | awk '{print "    " $1}' | sort -u
log "session bus names:"
busctl --user --address="$DBUS_SESSION_BUS_ADDRESS" list --no-pager --no-legend 2>/dev/null |
  awk '{print "    " $1}' | sort -u

log "running: $*"
exec "$@"
