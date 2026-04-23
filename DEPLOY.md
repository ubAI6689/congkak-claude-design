# Deployment

## Environments

| URL | Webroot on OVH | Source branch |
|---|---|---|
| `https://congkak.ubaidrac.xyz/` (prod) | `/var/www/congkak.ubaidrac.xyz/` | `main` |
| `https://congkak.ubaidrac.xyz/beta/` (MP dev, basic auth) | `/var/www/congkak.ubaidrac.xyz/beta/` | `multiplayer` |

**Beta auth**: `congkakmaster` / `M3kanikQu@ntum.CONGKAK` (from `/etc/nginx/htpasswd/congkak-beta`).

**WS server**: Node process in `/opt/congkak-server/` (systemd unit `congkak-server.service`), listening on `127.0.0.1:8787`. Nginx reverse-proxies `wss://congkak.ubaidrac.xyz/ws` → there. Also serves `engine.js` from that dir so the server and browser share the same reducer.

**SSH**: `ssh ovh` as user `ubuntu` (sudo OK). Cloudflare in front; aggressive caching — always bump `?cb=$(date +%s)` when verifying.

## Push a code change

```bash
cd ~/Desktop/claude_playground/personal/congkak-claude-design
git add <files>
git commit -m "..."
git push           # pushes current branch
```

## Deploy to prod (`main`)

Only static HTML — no server. After merging to `main`:

```bash
scp Congkak.html ovh:/tmp/ \
  && ssh ovh 'sudo mv /tmp/Congkak.html /var/www/congkak.ubaidrac.xyz/index.html \
              && sudo chown www-data:www-data /var/www/congkak.ubaidrac.xyz/index.html'
```

Prod uses a single inlined file — no separate `engine.js` expected at the root. If you merge MP to main, copy both:

```bash
scp Congkak.html engine.js ovh:/tmp/ \
  && ssh ovh 'sudo mv /tmp/Congkak.html /tmp/engine.js /var/www/congkak.ubaidrac.xyz/ \
              && sudo chown www-data:www-data /var/www/congkak.ubaidrac.xyz/Congkak.html /var/www/congkak.ubaidrac.xyz/engine.js'
```

(And rename one of them to `index.html` if needed — check what's there first.)

## Deploy to beta (`multiplayer`)

Three files to consider: `Congkak.html`, `engine.js`, `server/server.js`.

### Client only (HTML + engine.js)

```bash
scp Congkak.html engine.js ovh:/tmp/ \
  && ssh ovh 'sudo mv /tmp/Congkak.html /var/www/congkak.ubaidrac.xyz/beta/index.html \
              && sudo mv /tmp/engine.js /var/www/congkak.ubaidrac.xyz/beta/engine.js \
              && sudo chown www-data:www-data /var/www/congkak.ubaidrac.xyz/beta/index.html /var/www/congkak.ubaidrac.xyz/beta/engine.js \
              && echo deployed'
```

Hard-reload both browser tabs (Cmd+Shift+R) after deploy.

### Server only (`server/server.js`)

```bash
scp server/server.js ovh:/tmp/ \
  && ssh ovh 'sudo mv /tmp/server.js /opt/congkak-server/server.js \
              && sudo chown www-data:www-data /opt/congkak-server/server.js \
              && sudo systemctl restart congkak-server \
              && sleep 1 && sudo systemctl status congkak-server --no-pager | head -4'
```

### Engine changed (affects both client and server)

`engine.js` ships to the client (under `/beta/engine.js`) AND to the server (`/opt/congkak-server/engine.js`). The server requires it at module load — **restart the service after changing it**.

```bash
scp engine.js ovh:/tmp/engine-client.js \
  && scp engine.js ovh:/tmp/engine-server.js \
  && ssh ovh 'sudo mv /tmp/engine-client.js /var/www/congkak.ubaidrac.xyz/beta/engine.js \
              && sudo mv /tmp/engine-server.js /opt/congkak-server/engine.js \
              && sudo chown www-data:www-data /var/www/congkak.ubaidrac.xyz/beta/engine.js /opt/congkak-server/engine.js \
              && sudo systemctl restart congkak-server'
```

### All three at once (client + server + engine)

```bash
scp Congkak.html engine.js server/server.js ovh:/tmp/ \
  && ssh ovh 'sudo mv /tmp/Congkak.html /var/www/congkak.ubaidrac.xyz/beta/index.html \
              && sudo cp /tmp/engine.js /var/www/congkak.ubaidrac.xyz/beta/engine.js \
              && sudo mv /tmp/engine.js /opt/congkak-server/engine.js \
              && sudo mv /tmp/server.js /opt/congkak-server/server.js \
              && sudo chown www-data:www-data /var/www/congkak.ubaidrac.xyz/beta/index.html /var/www/congkak.ubaidrac.xyz/beta/engine.js /opt/congkak-server/engine.js /opt/congkak-server/server.js \
              && sudo systemctl restart congkak-server \
              && echo deployed'
```

## Verify after deploy

```bash
# Check client is serving latest
curl -sI -u 'congkakmaster:M3kanikQu@ntum.CONGKAK' "https://congkak.ubaidrac.xyz/beta/?cb=$(date +%s)" | head -5

# Check server is up
ssh ovh 'sudo systemctl status congkak-server --no-pager | head -4'

# Tail server logs
ssh ovh 'sudo journalctl -u congkak-server -f -n 20'

# Quick WS round-trip test (needs `ws` module; run from repo's server/ dir)
cd server && node -e "
const WS = require('ws');
const ws = new WS('wss://congkak.ubaidrac.xyz/ws');
ws.on('open', () => ws.send(JSON.stringify({type:'ping'})));
ws.on('message', m => { console.log(m.toString()); if (JSON.parse(m).type==='pong') ws.close(); });
ws.on('close', () => process.exit(0));
"
```

## Rollback

Nginx config backup was made: `/etc/nginx/sites-available/congkak.bak-<timestamp>`.

To revert the beta HTML to a known-good deploy: old index lives at `/var/www/congkak.ubaidrac.xyz.bak-20260420-104426/` from before the MP work started.

To rollback server code: `git log`, pick commit, `git checkout <sha> -- server/server.js engine.js`, redeploy.

## Engine tests (before any engine change)

```bash
node test-engine.js       # should report "Total: N passed, 0 failed"
```

## Service management

```bash
ssh ovh 'sudo systemctl start   congkak-server'
ssh ovh 'sudo systemctl stop    congkak-server'
ssh ovh 'sudo systemctl restart congkak-server'
ssh ovh 'sudo systemctl status  congkak-server'
ssh ovh 'sudo journalctl -u congkak-server -n 50 --no-pager'
```

## Common pitfalls

- **Cloudflare cache**: changes sometimes don't appear on reload. Add `?cb=$(date +%s)` to URL or purge CF cache.
- **Forgetting to restart the server** after `engine.js` or `server.js` changes — clients look fine but server runs stale code.
- **Only deploying to one side** when `engine.js` changed — client and server reducers drift. Always deploy to both.
- **Merging `multiplayer` to `main`**: main currently has no `engine.js` or server. If you merge, prod will try to load `engine.js` which doesn't exist at `/` unless you deploy it too. Update the `<script src="./engine.js">` reference and deploy both.
