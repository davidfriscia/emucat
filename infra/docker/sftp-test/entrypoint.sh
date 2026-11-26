#!/bin/sh
# Starts sshd with the keys a test chose:
#   HOST_KEY_B64        the host's private key, base64
#   AUTHORIZED_KEY      the public key the emucat account accepts
#   SFTP_DENY           optional SFTP requests to refuse, such as hardlink, as if the server lacked them
set -eu

printf '%s' "$HOST_KEY_B64" | base64 -d > /etc/ssh/keys/host_key
chmod 600 /etc/ssh/keys/host_key

mkdir -p /home/emucat/.ssh
printf '%s\n' "$AUTHORIZED_KEY" > /home/emucat/.ssh/authorized_keys
chown -R emucat:emucat /home/emucat/.ssh
chmod 700 /home/emucat/.ssh
chmod 600 /home/emucat/.ssh/authorized_keys

# The repository may be a fresh tmpfs, which starts out owned by root.
chown emucat:emucat /srv/sftp/repo
chmod 755 /srv/sftp/repo

DENY=""
if [ -n "${SFTP_DENY:-}" ]; then
  DENY="-P $SFTP_DENY"
fi

cat > /etc/ssh/sshd_config <<EOF
Port 22
HostKey /etc/ssh/keys/host_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers emucat
AuthorizedKeysFile /home/emucat/.ssh/authorized_keys
Subsystem sftp internal-sftp
# Every connection from the host reaches the container from one address, the Docker gateway. OpenSSH 9.8+
# penalizes an address whose pre-authentication child crashes, and one does when a test freezes the server
# (docker pause) mid-handshake: the penalty would then refuse every later connection of the whole test file,
# the agent's and the API's alike, with "Disconnected". A real server's clients have addresses of their own.
PerSourcePenalties no
Match User emucat
  ChrootDirectory /srv/sftp
  ForceCommand internal-sftp $DENY
  AllowTcpForwarding no
  X11Forwarding no
  PermitTTY no
EOF

exec /usr/sbin/sshd -D -e
