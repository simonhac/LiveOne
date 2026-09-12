#!/bin/sh
set -eu
# Opt-in only. The original production server and its Access ingress stay on loopback.
[ "${USHER_TRIAL_FORWARDING:-}" = 1 ] || exit 0
trial_dir=/etc/usher/trial
for required_file in client.pub feed.crt feed.key; do
  test -s "$trial_dir/$required_file"
done
ssh-keygen -l -f "$trial_dir/client.pub" >/dev/null
mkdir -p /data/usher/trial-ssh /run/sshd
chmod 700 /data/usher/trial-ssh
if [ ! -f /data/usher/trial-ssh/host_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /data/usher/trial-ssh/host_key
fi
# A random, undisclosed password unlocks the Unix account for public-key auth;
# this sshd disables password and keyboard-interactive authentication entirely.
printf 'trial-forward:%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" | chpasswd
{
  printf 'restrict,port-forwarding,command="/bin/false",permitopen="10.0.1.190:80",permitopen="10.0.1.191:80" '
  cat "$trial_dir/client.pub"
} > "$trial_dir/authorized_keys"
chmod 600 "$trial_dir/authorized_keys" "$trial_dir/feed.key"
chown trial-forward "$trial_dir/authorized_keys"
cat > "$trial_dir/sshd_config" <<'CONFIG'
Port 2222
ListenAddress fly-local-6pn
HostKey /data/usher/trial-ssh/host_key
AuthorizedKeysFile /etc/usher/trial/authorized_keys
AllowUsers trial-forward
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
AllowTcpForwarding local
PermitOpen 10.0.1.190:80 10.0.1.191:80
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
GatewayPorts no
ForceCommand /bin/false
CONFIG
/usr/sbin/sshd -t -f "$trial_dir/sshd_config"
cat > "$trial_dir/Caddyfile" <<'CONFIG'
{
  admin off
  auto_https off
}
https://:8443 {
  bind fly-local-6pn
  tls /etc/usher/trial/feed.crt /etc/usher/trial/feed.key
  @trial {
    method GET
    path /api/usher/trial
  }
  handle @trial {
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    respond 404
  }
}
CONFIG
caddy validate --config "$trial_dir/Caddyfile" --adapter caddyfile
(while :; do /usr/sbin/sshd -D -e -f "$trial_dir/sshd_config" || true; sleep 5; done) &
(while :; do caddy run --config "$trial_dir/Caddyfile" --adapter caddyfile || true; sleep 5; done) &
