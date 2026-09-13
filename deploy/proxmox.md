# Running CCCS on Proxmox

An LXC container, not a VM. The workload is one Node process and a SQLite file;
a full VM buys you nothing here and costs you RAM and a boot cycle.

## 1. Create the container

On the Proxmox host:

```bash
# Grab a Debian 12 template if you don't have one
pveam update && pveam available | grep debian-12
pveam download local debian-12-standard_12.7-1_amd64.tar.zst

pct create 140 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname cccs \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.140/24,gw=192.168.1.1 \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  --start 1
```

Adjust the IP, bridge and storage to match your setup. `--onboot 1` matters: a
control room that does not come back after a power cut is not a control room.

`nesting=1` is needed for systemd to behave properly inside an unprivileged
container.

## 2. Install

```bash
pct enter 140
apt update && apt install -y git curl rsync
git clone <your repo url> /opt/src && cd /opt/src
bash deploy/install.sh cccs.yourcompany.co.uk
```

## 3. Certificates — pick one

**A. The container gets its own certificate.** Forward ports 80 and 443 from your
router to 192.168.1.140. Caddy handles the rest, including renewal. Simplest if
CCCS is the only thing you expose.

**B. You already have a reverse proxy.** More likely, given you are running other
sites. Terminate TLS at your existing proxy and point it at the container. Then
inside the container, replace `/etc/caddy/Caddyfile` with:

```
:4000 {
	reverse_proxy 127.0.0.1:4000
}
```

or simply stop Caddy there and let the app listen directly.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name cccs.yourcompany.co.uk;

    ssl_certificate     /etc/letsencrypt/live/cccs.yourcompany.co.uk/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cccs.yourcompany.co.uk/privkey.pem;

    location / {
        proxy_pass http://192.168.1.140:4000;
        proxy_http_version 1.1;

        # WebSockets carry every status change, PTT event and emergency alert.
        # Without these three lines the consoles connect and then go silent.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy on the host

```
cccs.yourcompany.co.uk {
	reverse_proxy 192.168.1.140:4000
}
```

Caddy proxies WebSockets correctly without extra configuration.

### Proxying is not optional on TLS

Whatever you use, the browsers need HTTPS or they will refuse microphone access
and the radios will have no audio at all — no error, just silence.

## 4. Backups off the box

`deploy/install.sh` schedules a nightly dump to `/var/backups/cccs`. That is on
the same disk as the database, which means it survives a mistake but not a disk
failure. Add one of these:

**Proxmox host pulls it:**
```bash
# on the host, in cron
rsync -a root@192.168.1.140:/var/backups/cccs/ /mnt/backups/cccs/
```

**Or push to object storage** — uncomment the `rclone` line at the bottom of
`deploy/backup.sh` and configure a remote. A few pounds a month.

Then restore one. An untested backup is a hope, not a backup.

## 5. Snapshots are not backups either

`pct snapshot 140 pre-upgrade` before you deploy a change is genuinely useful and
takes a second. It is not a substitute for the database dump, because a snapshot
of a live SQLite file can capture a half-written transaction.

## What self-hosting means here

Two honest trade-offs against a VPS:

- **Your line is now part of the system.** If the office broadband drops, so does
  the control room, and the officers in vehicles lose it too. If that is a real
  risk, keep a 4G failover on the router or accept a documented degraded mode —
  officers have phones.
- **Nobody else is watching it.** Put uptime monitoring on it that pages you
  (Healthchecks.io, UptimeRobot), because you will not notice the container
  failing to start at 3am otherwise.

Against that: no monthly bill, the data stays on hardware you own, and you are
not one supplier's policy change away from a migration.
