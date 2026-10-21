# Apache Guacamole: replacing TeamViewer

[Guacamole](https://guacamole.apache.org/) is a self-hosted remote access
gateway. You sign in at `https://remote.yourdomain.com` and pick a machine. It
opens in the browser over RDP, VNC or SSH. Nothing is installed on the device
you connect *from*, and nothing goes through a third-party relay.

## Before you start: Guacamole works differently from TeamViewer

| Need | TeamViewer | Guacamole |
|---|---|---|
| Admin access to servers and office PCs (unattended) | Agent + ID | **Strong fit.** RDP/SSH straight to the machine, with per-user permissions, an audit trail and optional session recording |
| Reaching a machine on another network (a home worker, a client site) | Works through any NAT through TeamViewer's cloud | **Only if the Guacamole server can reach it.** Use the office network, the existing VPN, or site-to-site WireGuard. See [Remote machines](#machines-off-the-office-network) |
| Watching or sharing a user's **live** screen while they talk you through a problem | Built in, with an accept prompt | **Needs VNC on the endpoint.** RDP to a Windows 10/11 PC signs the user out of their session. See [Attended support](#attended-support-seeing-the-users-screen) |
| Connecting from any browser, phone included | App needed | Any browser |
| Cost / data path | Per-seat licence, vendor cloud | Free (Apache 2.0). Traffic stays on your own server |

Most organisations use Guacamole for all admin and unattended access and keep
a small attended-support tool, or VNC, for desk-side help. Decide which group
each of your current TeamViewer uses falls into before you cancel the licence.

## Architecture

```
 browser ──HTTPS──▶ Caddy ──▶ guacamole (web app) ──▶ guacd ──RDP/VNC/SSH──▶ your machines
                     :443          │                        (on LAN / VPN)
                                   ▼
                                postgres (users, connections, history)
```

Only port 443 (plus 80 for certificate issuance) is exposed. guacd is the
component that connects to target machines, so **the Guacamole VM needs
network access to every machine you want to reach**, on 3389 (RDP), 5900
(VNC) or 22 (SSH).

## 1. Create its own container on Proxmox (one command)

Copy this folder to the Proxmox host, then run as root there:

```bash
scp -r infra/guacamole root@<proxmox-host>:/root/
ssh root@<proxmox-host>
cd /root/guacamole
bash proxmox-lxc.sh 150 192.168.1.150/24 192.168.1.1 remote.yourdomain.com
#                   ctid  ip/cidr          gateway     domain   [bridge] [storage]
```

[`proxmox-lxc.sh`](proxmox-lxc.sh) downloads a Debian 12 template if needed
and creates an unprivileged LXC container with 2 cores, 4 GB RAM and 20 GB
disk. It turns on `nesting` and `keyctl` (which Docker needs), sets the
container to start on boot, copies the kit in and runs `install.sh` inside.
It defaults to bridge `vmbr0` and storage `local-lvm`. Pass the last two
arguments to change them. The container then runs on its own, separate from
CCCS. The install step continues at section 3.

- Put it on the LAN/VLAN that can reach your servers and PCs, and through
  your VPN to any remote sites. Allow about 1 vCPU per 10–15 simultaneous
  RDP sessions. Recordings need extra disk if you turn them on.
- Static IP (e.g. `192.168.1.150`). Endpoints only allow RDP from this IP.
- DNS: `remote.yourdomain.com` → your public IP. Router: forward TCP 80/443
  (and UDP 443) to the container's IP.

If you'd rather use a full VM, create a Debian 12 VM with the same
specs and follow section 2 inside it.

If you only want Guacamole reachable over the VPN, skip the port forward and
point an internal DNS name at the VM. Caddy then needs a
[DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge)
or `tls internal` to get a certificate.

### Behind an existing edge proxy

If another proxy already holds ports 80/443 and handles HTTPS for your sites,
point it at `http://<container-ip>:80`. Then make Caddy serve the public name
over plain HTTP, so it doesn't redirect back to HTTPS and loop
(`ERR_TOO_MANY_REDIRECTS`). In `/opt/guacamole/Caddyfile`:

```
{
    default_sni 192.168.7.170
    servers {
        trusted_proxies static private_ranges
    }
}

http://remote.yourdomain.com {
    reverse_proxy guacamole:8080
}

https://192.168.7.170 {
    tls internal
    reverse_proxy guacamole:8080
}
```

`trusted_proxies` passes the visitor's real IP through from the edge proxy.
Without it, Guacamole bans the proxy's IP after 5 failed logins and blocks
everyone. The edge proxy must send `X-Forwarded-For` and allow WebSockets.

## 2. Install (VM only — the container script already did this)

```bash
git clone <this repo> && cd cad/infra/guacamole
sudo bash install.sh remote.yourdomain.com
```

This installs Docker, generates a database password in `/opt/guacamole/.env`,
creates the schema, starts everything and schedules a nightly database
backup. Open `https://remote.yourdomain.com/`.

## 3. Lock it down (do this first)

1. Sign in as **guacadmin / guacadmin**.
2. *Settings → Users → New user*. Create your own admin account and tick
   every permission.
3. Sign out, sign in as your account, and enrol TOTP (scan the QR code with
   Microsoft Authenticator).
4. Delete `guacadmin`, or set a long random password on it and keep it in
   your password manager as break-glass.

Repeated failed logins are blocked automatically (the built-in ban extension
in 1.6).

## 4. Entra ID sign-in (recommended)

Staff sign in with their Microsoft 365 account, with your existing
Conditional Access and MFA.

1. **entra.microsoft.com → App registrations → New registration**
   - Name: `Guacamole`. Single tenant.
   - Redirect URI: platform **Web**, `https://remote.yourdomain.com/`
     (keep the trailing slash).
2. **Authentication**: tick **ID tokens (used for implicit and hybrid
   flows)**. Guacamole's OpenID support uses the implicit flow, so no client
   secret is needed.
3. **Token configuration → Add groups claim → Security groups**.
4. Note the **Directory (tenant) ID** and **Application (client) ID**.
5. On the server:
   ```bash
   cd /opt/guacamole
   cp openid.env.example openid.env && nano openid.env   # fill in the IDs and domain
   docker compose up -d
   ```
6. The login page now has a **Sign in with OpenID** link under the local form.

**Permissions via Entra groups.** Create a Guacamole *user group* named with
the Entra group's **Object ID** (e.g. `3f2a…`). Give it connections. Members
of that Entra group get those connections on sign-in. For example:
`IT Admins` → all servers; `Support` → staff PCs only.

**Make Microsoft the only sign-in** once your own Microsoft account has admin
rights in Guacamole: set `EXTENSION_PRIORITY=openid` in `openid.env` and
`TOTP_ENABLED=false` in `.env`, then `docker compose up -d`. Visitors now go
straight to Microsoft, with Entra MFA instead of a separate Guacamole
TOTP code. If Microsoft sign-in ever breaks, set it back to
`EXTENSION_PRIORITY=*, openid` from the Proxmox console to get the local
login form back.

To limit who can sign in at all, open **Enterprise applications → Guacamole →
Properties** and set **Assignment required** to Yes. Then assign your IT
group under **Users and groups**.

## 5. Add machines

### Windows (RDP)

On each PC/server, run [`endpoints/enable-rdp.ps1`](endpoints/enable-rdp.ps1)
elevated, or deploy it through Intune/GPO:

```powershell
.\enable-rdp.ps1 -GuacamoleIp 192.168.1.150 -AllowGroup "COMPANY\IT Support"
```

It enables RDP with NLA and limits port 3389 to the Guacamole server on
Domain/Private network profiles.

In Guacamole: *Settings → Connections → New connection*

- Protocol **RDP**, hostname/IP, port 3389
- **Security mode**: `NLA` (use `Any` if a machine refuses)
- **Ignore server certificate**: tick it for machines with self-signed RDP
  certificates (that is most of them)
- Username/password: leave blank to prompt, or use `${GUAC_USERNAME}` /
  `${GUAC_PASSWORD}` to pass the user's own login through. Pass-through only
  works for local accounts, not SSO.
- Put connections in groups (`Servers`, `Office PCs`, `Site A`) and grant
  groups to user groups.

### Linux / network gear (SSH)

Protocol **SSH**, host, port 22. Private-key authentication is supported in
the connection settings.

### Session recording (optional, for audit)

On a connection, under *Screen Recording*:

- Recording path: `${HISTORY_PATH}/${HISTORY_UUID}`
- Tick **Automatically create recording path**

Recordings play back from *Settings → History*. They land in
`/opt/guacamole/data/recordings`, so watch disk usage.

## Attended support (seeing the user's screen)

RDP opens its own session. On Windows 10/11 it signs out the person at the
keyboard. To see and share what they see:

- Install a VNC server on those PCs (e.g. **TightVNC** or **UltraVNC**, both
  free and deployable by MSI). Set it to **ask the user to accept** incoming
  connections and to allow only the Guacamole server's IP. Use a strong VNC
  password.
- Add a **VNC** connection in Guacamole, port 5900.
- If you need ad-hoc help for people who aren't on your network at all,
  Guacamole isn't the right tool. Keep a small tool for that case
  (e.g. RustDesk, self-hosted, or Quick Assist, built into Windows and free).

## Machines off the office network

guacd has to reach each target. Options, best first:

1. **Site-to-site VPN / WireGuard** between the Guacamole VM and each site.
2. Laptops on your **existing always-on VPN**. Connect to their VPN IP. The
   firewall rule in `enable-rdp.ps1` allows the Guacamole IP on
   Domain/Private profiles only. If the VPN adapter comes up as Public, mark
   it Private.
3. **Tailscale / Headscale** on the Guacamole VM and the endpoints. This is
   the easiest way to reach scattered home machines.

Never forward 3389/5900 from the internet to endpoints. Guacamole is the
only thing that should be published.

## Running it

```bash
cd /opt/guacamole
docker compose ps                     # status
docker compose logs -f guacamole      # web app / login problems
docker compose logs -f guacd          # connection problems ("upstream error")
./backup.sh                           # manual DB backup → /var/backups/guacamole
```

**Restore**: stop the stack, empty `data/postgres`, start postgres only, then
`gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U guacamole_user -d guacamole_db`.
The schema in `initdb/` is recreated first. Drop and recreate the database
before restoring if the dump conflicts.

**Upgrade**: change the `guacd` and `guacamole` image tags in
`docker-compose.yml` (always keep them on the same version), read the
[release notes](https://guacamole.apache.org/releases/) for schema upgrade
scripts, back up, then `docker compose pull && docker compose up -d`.

Also snapshot the VM in Proxmox before upgrades.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Connection closes immediately / "upstream error" | guacd can't reach the host (firewall, VPN, wrong IP), or wrong security mode. Try `Any` and tick *Ignore server certificate* |
| "Server certificate" / NLA errors | Set Security mode to `Any`. Check the account is in *Remote Desktop Users* |
| OpenID: redirect loop or "invalid redirect" | `OPENID_REDIRECT_URI` must match Entra exactly, trailing slash included. Check the ID tokens box is ticked |
| SSO user signs in but sees no connections | Expected until you grant them, or create a user group named with their Entra group's Object ID |
| Certificate not issued | DNS doesn't point here yet, or port 80 isn't forwarded |

## TeamViewer cut-over checklist

- [ ] Inventory every machine and use currently on TeamViewer, and mark each
      as unattended (RDP/SSH), attended (VNC / other tool) or off-network (needs VPN)
- [ ] Deploy Guacamole, lock down guacadmin, set up Entra SSO
- [ ] Roll out `enable-rdp.ps1` (and VNC where needed) by GPO/Intune
- [ ] Create connection groups and user groups, and test with a pilot team for 2 weeks
- [ ] Confirm backups land and copy off-box. Test a restore once
- [ ] Uninstall TeamViewer from endpoints, then cancel the licence
