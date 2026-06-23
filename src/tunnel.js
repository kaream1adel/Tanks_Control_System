// Optional Cloudflare Tunnel so people on other networks can reach this one host
// over the internet — free, no account, data stays on this PC. We run a "quick
// tunnel" which yields an https://<random>.trycloudflare.com URL. The app shows
// the current URL on the Share page (it changes if the host restarts).
//
// cloudflared.exe is downloaded once into the app folder on first use.
import { spawn } from 'child_process';
import https from 'https';
import fs from 'fs';
import { join } from 'path';
import { ROOT } from './paths.js';

const BIN = join(ROOT, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const DL_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

let _url = null;
let _status = 'off'; // off | downloading | starting | on | error
let _error = '';
let _proc = null;
let _stopped = false; // set true on an intentional stop so we don't auto-restart
export const tunnelInfo = () => ({ url: _url, status: _status, error: _error });

function download(url, dest, cb, redirects = 0) {
  const file = fs.createWriteStream(dest);
  https.get(url, { headers: { 'User-Agent': 'tank-control' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
      file.close(); fs.rmSync(dest, { force: true });
      return download(res.headers.location, dest, cb, redirects + 1);
    }
    if (res.statusCode !== 200) { file.close(); fs.rmSync(dest, { force: true }); return cb(new Error('HTTP ' + res.statusCode)); }
    res.pipe(file);
    file.on('finish', () => file.close(() => cb(null)));
  }).on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); cb(e); });
}

function spawnTunnel(port) {
  _status = 'starting'; _error = '';
  const cp = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
  _proc = cp;
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && _url !== m[0]) { _url = m[0]; _status = 'on'; console.log(`  🌐 Public link (share it): ${_url}`); }
  };
  cp.stdout.on('data', scan);
  cp.stderr.on('data', scan); // cloudflared prints the URL to stderr
  cp.on('error', (e) => { _status = 'error'; _error = e.message; });
  cp.on('exit', () => {
    _proc = null; _url = null; _status = _stopped ? 'off' : 'off';
    if (!_stopped) setTimeout(() => { if (!_stopped) spawnTunnel(port); }, 5000); // crash → auto-restart
  });
}

export function startTunnel(port) {
  _stopped = false;
  if (_proc || _status === 'downloading' || _status === 'starting') return; // already up / coming up
  if (fs.existsSync(BIN)) return spawnTunnel(port);
  _status = 'downloading';
  console.log('  ⬇  downloading cloudflared (one-time, ~50MB)…');
  download(DL_URL, BIN, (err) => {
    if (_stopped) return; // user turned it off mid-download
    if (err) { _status = 'error'; _error = 'download failed: ' + err.message; console.log('  cloudflared ' + _error); return; }
    console.log('  ✓ cloudflared ready');
    spawnTunnel(port);
  });
}

export function stopTunnel() {
  _stopped = true;
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
  _url = null; _status = 'off'; _error = '';
}
