#!/usr/bin/env node
/* Copies one backup archive off this server, into a OneDrive folder in the
 * company's Microsoft 365, using the Microsoft app CCCS already signs in and
 * sends email with (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET). Then
 * removes the oldest copies there so the folder keeps BACKUP_REMOTE_KEEP.
 *
 *   node offsite-copy.js /var/backups/cccs/cccs-20261110-023000.tar.gz.enc
 *
 * Called by deploy/backup.sh when BACKUP_ONEDRIVE_USER is set. Settings come
 * from the environment or /etc/cccs/cccs.env:
 *   BACKUP_ONEDRIVE_USER    whose OneDrive, e.g. andrew.boucher@echeloncic.com
 *   BACKUP_ONEDRIVE_FOLDER  folder in it                    (CCCS backups)
 *   BACKUP_REMOTE_KEEP      copies to keep there            (30)
 *
 * The app needs the Files.ReadWrite.All APPLICATION permission, admin
 * consented, in Entra (deploy/proxmox.md §4 has the clicks). The archives
 * are already encrypted with backup.key before they leave, so Microsoft
 * holds ciphertext only.
 *
 * Exit 0 = copied; anything else = NOT copied, with the reason on stderr. */
'use strict';
const fs = require('fs');
const path = require('path');

const ENV_FILE = process.env.ENV_FILE || '/etc/cccs/cccs.env';
let fileEnv = {};
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) fileEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no env file: environment only */ }
const cfg = (k, d = '') => (process.env[k] || fileEnv[k] || d).trim();

const GRAPH = cfg('GRAPH_BASE', 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const LOGIN = cfg('LOGIN_BASE', 'https://login.microsoftonline.com').replace(/\/+$/, '');
const TENANT = cfg('MS_TENANT_ID'), CLIENT = cfg('MS_CLIENT_ID'), SECRET = cfg('MS_CLIENT_SECRET');
const USER = cfg('BACKUP_ONEDRIVE_USER');
const FOLDER = cfg('BACKUP_ONEDRIVE_FOLDER', 'CCCS backups').replace(/^\/+|\/+$/g, '');
const KEEP = Math.max(1, parseInt(cfg('BACKUP_REMOTE_KEEP', '30'), 10) || 30);
// Graph wants upload chunks in multiples of 320 KiB; 10 MiB is 32 of them.
const CHUNK = Math.max(1, parseInt(cfg('BACKUP_CHUNK_KB', '10240'), 10)) * 1024;

const die = (msg) => { console.error(`NOT copied off this server: ${msg}`); process.exit(1); };
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

async function token() {
  const res = await fetch(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${data.error_description || res.status}`);
  return data.access_token;
}

async function graph(tok, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const why = (data && data.error && (data.error.message || data.error.code)) || text.slice(0, 200) || res.status;
    const hint = res.status === 403 || res.status === 401 ? ' (does the app have the Files.ReadWrite.All application permission, admin consented?)' : '';
    throw new Error(`${method} ${url.replace(GRAPH, '')} → ${res.status}: ${why}${hint}`);
  }
  return data;
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) die(`no such file: ${file || '(none given)'}`);
  if (!TENANT || !CLIENT || !SECRET) die('MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET must be set in cccs.env');
  if (!USER) die('BACKUP_ONEDRIVE_USER is not set');
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const tok = await token();
  const drive = `/users/${encodeURIComponent(USER)}/drive`;

  const session = await graph(tok, 'POST', `${drive}/root:/${enc(FOLDER)}/${encodeURIComponent(name)}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
  const fd = fs.openSync(file, 'r');
  let item = null;
  try {
    for (let start = 0; start < size || (size === 0 && start === 0); start += CHUNK) {
      const len = Math.min(CHUNK, size - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let res, tries = 0;
      for (;;) {
        // The upload URL is pre-authorised: no bearer token on these.
        res = await fetch(session.uploadUrl, {
          method: 'PUT', body: buf,
          headers: { 'content-length': String(len), 'content-range': `bytes ${start}-${start + len - 1}/${size}` },
        }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
        if (res.ok || ++tries >= 4) break;
        await new Promise((r) => setTimeout(r, 2000 * tries));
      }
      if (!res.ok) throw new Error(`upload failed at byte ${start}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (res.status === 200 || res.status === 201) item = await res.json().catch(() => null);
      if (size === 0) break;
    }
  } finally { fs.closeSync(fd); }
  if (!item || Number(item.size) !== size) throw new Error(`OneDrive reports ${item ? item.size : 'no'} bytes, expected ${size}`);
  console.log(`Copied off this server to OneDrive (${USER}) /${FOLDER}/${name}`);

  // Keep the newest KEEP archives there. Only touch files this script names
  // (cccs-*.tar.gz*), never anything else someone put in the folder.
  let children = [];
  let next = `${drive}/root:/${enc(FOLDER)}:/children?$select=id,name,size&$top=200`;
  while (next) { const page = await graph(tok, 'GET', next); children.push(...(page.value || [])); next = page['@odata.nextLink'] || null; }
  const ours = children.filter((c) => /^cccs-\d{8}-\d{6}\.tar\.gz(\.enc)?$/.test(c.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const old of ours.slice(KEEP)) {
    try { await graph(tok, 'DELETE', `${drive}/items/${encodeURIComponent(old.id)}`); console.log(`Removed old off-server copy ${old.name}`); }
    catch (e) { console.error(`WARNING: could not remove old copy ${old.name}: ${e.message}`); }
  }
}

main().catch((e) => die(e.message));
