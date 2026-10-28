#!/usr/bin/env bash
# Install / update the media fix helper on the Jellyfin box (CT 105), as root, from a copy of the jellyfinNX repo:
#   tar -C ~/projects/jellyfinNX -c scripts mediafix-helper | ssh root@192.168.0.242 \
#     'pct exec 105 -- bash -c "rm -rf /root/mediafix-src && mkdir /root/mediafix-src && tar -x -C /root/mediafix-src && bash /root/mediafix-src/mediafix-helper/install.sh"'
# Programs → /opt/mediafix (root-owned, so no clean-up of home or movie folders can remove them); working files and
# logs → /var/lib/mediafix (owned by the service user). Safe to run again (JTV-18).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME=nitin
SUBLIMINAL_VERSION=${SUBLIMINAL_VERSION:-2.7.1}

install -d -o root -g root -m 755 /opt/mediafix
install -o root -g root -m 755 "$SRC/scripts/fix-subtitles.sh" "$SRC/scripts/fix-movie-audio.sh" "$SRC/mediafix-helper/helper.py" /opt/mediafix/
cat > /opt/mediafix/README.txt <<'TXT'
IN USE - do not delete. Programs behind Jellyfin's "Fetch Subtitle" and "Fix Audio" buttons (mediafix-helper service).
Source: jellyfinNX repo (scripts/, mediafix-helper/); update with mediafix-helper/install.sh. Working files: /var/lib/mediafix.
TXT
if [ ! -x /opt/mediafix/venv/bin/subliminal ]; then
  python3 -m venv /opt/mediafix/venv
  /opt/mediafix/venv/bin/pip install -q "subliminal==$SUBLIMINAL_VERSION"
fi
chown -R root:root /opt/mediafix

install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 /var/lib/mediafix
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 /var/lib/mediafix/work /var/lib/mediafix/logs
OLD=/home/$USER_NAME/jellyfin_audio_fix   # before 28 Oct 2026: move its logs and work files over once
for d in logs work; do
  if [ -d "$OLD/$d" ] && [ -n "$(ls -A "$OLD/$d" 2>/dev/null)" ]; then
    cp -a -n "$OLD/$d/." "/var/lib/mediafix/$d/"
  fi
done
chown -R "$USER_NAME:$USER_NAME" /var/lib/mediafix

install -o root -g root -m 644 "$SRC/mediafix-helper/mediafix-helper.service" /etc/systemd/system/mediafix-helper.service
systemctl daemon-reload
systemctl restart mediafix-helper
sleep 2
systemctl is-active mediafix-helper
