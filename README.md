# VOIDRUNNER

Pixel-art space roguelike with solo play and **online co-op for up to four players in one shared arena**. Each pilot controls a separate colored ship. No Sites account or dependency.

## Cloudflare backend (local client)

The Cloudflare port runs the **backend**, not just static HTML. `cloudflare/worker.js` uses a Worker and a SQLite-backed Durable Object to coordinate WebSockets and run the same authoritative simulation. It also supports browser-hosted WebRTC signaling. The portable HTML is the client.

### Deploy from your laptop

```sh
npm ci
npx wrangler login
npm run deploy:cloudflare
```

Wrangler prints the deployed HTTPS URL. Open `downloads/voidrunner.html`, select **Dedicated server**, open **Server connection**, and enter that URL. Every player uses the same URL and room code. Choose **Player browser** instead if you want Cloudflare to provide signaling while one browser runs the match.

You can also deploy from the repository's **Deploy Cloudflare backend** GitHub Action after setting repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Use Cloudflare's Edit Workers template with access to the selected account. Do not paste secrets into chat or commit them. The workflow is manual so code changes do not silently deploy against an unselected account.

### India placement: target, not a promise

`wrangler.jsonc` sets Worker placement to `aws:ap-south-1` (near Mumbai). The Durable Object requests `apac`. Cloudflare decides the actual data center; these settings do **not** guarantee that room simulation runs inside India. Worker placement and Durable Object placement are distinct.

`/health` reports readiness and configured hints. `/location` returns request ingress metadata and an observed egress colo from a trace request. Neither field is a contractual proof of the Durable Object's physical location. Measure the lobby's actual RTT with players in India. If strict Mumbai/India compute placement is required, use a provider with an explicit Indian compute region instead.

Location hints apply on first creation. `ARENA_INSTANCE` selects the logical object; changing it creates a fresh arena instance and does not relocate or preserve old rooms. Keep all clients on the same service and instance. This version uses one regional arena object for small-scale casual co-op, capped at 50 authoritative rooms and 50 peer rooms. Active sockets keep the object awake, and its 60 Hz simulation clock runs only while a dedicated-server room exists; Cloudflare quotas and usage charges can apply. Runs are in memory and are lost on restart/deployment. Review your account's plan before deployment.

Cloudflare references:
- https://developers.cloudflare.com/workers/configuration/placement/
- https://developers.cloudflare.com/durable-objects/reference/data-location/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/

### Local Cloudflare verification

`npm run dev:cloudflare` starts the backend in Wrangler's local runtime at port 8787. `npm run check:cloudflare` validates/bundles it without deployment. Browser tests exercise four local HTML files against that runtime, in both server and peer modes.

## Portable HTML client

Download `downloads/voidrunner.html` (or use **Download HTML** in the game header). It is one self-contained file: no installation, dependencies, or asset downloads. Open it in a modern desktop browser.

- **Solo:** works offline.
- **Join online:** uses the configured Render service by default; enter a different service in Server connection if desired.
- **Host direct co-op:** choose Player browser and Create Room. The simulation runs inside this HTML file; Render only introduces the peers. Share the code with friends.
- Online still needs internet, signaling and possibly TURN. This file does not start a Node/HTTP/WebSocket listening server. For a laptop server use `npm start` and a tunnel as documented below.
- The host's simulation keeps running in a background tab, but the host's own ship stops while its tab is hidden. Desktop Chromium and Firefox are the intended targets; file-opening behavior varies on mobile.

Rebuild after changing game code with `npm run build:client`. The generated HTML is tracked so it can be downloaded from any static host. CI checks that it is current, loads it from a real `file://` URL, and exercises peer connections.

## Connection modes

**Player browser (default):** one player's browser runs the authoritative simulation. Other browsers exchange controls and snapshots directly with that host via WebRTC data channels. Render handles room discovery and SDP/ICE signaling only; gameplay does not travel through Render. Everyone must choose the same mode. Once connected, a direct match no longer needs the signaling connection. Keep the host's laptop awake; its simulation keeps running in a background tab. If the host leaves, the match ends; host migration is not implemented in direct mode.

**Dedicated server (fallback):** the Node server runs the same simulation. Choose this when direct peer connections fail, or use a nearby server. The lobby shows measured round-trip latency to the match host, not just the signaling service.

WebRTC still needs signaling and ICE discovery. The default public STUN server helps discover direct routes; some corporate/mobile networks need TURN. No TURN service is bundled. Configure `window.VOIDRUNNER_ICE_SERVERS` with your own ICE servers if needed; never commit long-lived TURN secrets to a public repository. Without TURN, use dedicated-server mode when direct connections fail.

## Netcode

The match authority (a player's browser, the Node server, or the Cloudflare Durable Object) simulates at 60 Hz and publishes 30 times a second. Protocol v2 (`shared/protocol.js`) splits what it sends in two:

- **Journal, reliable and sent once:** volleys, enemy shot spreads, projectile removals from hits, hit and explosion effects, and roster or upgrade changes. Projectiles fly in straight lines, so a whole volley is one small entry and each client computes every bullet's position itself.
- **State, latest only:** ships, enemies and score. Losing one is harmless because the next one replaces it.

Over WebSocket both parts travel in one message. In direct mode the journal uses the reliable data channel and state uses the unreliable one. A client that misses a journal batch asks for a full sync, and an authority that has to skip a batch for a backed-up connection sends one on its own. Each message is encoded once and shared by every player in the room.

Four pilots now need roughly 0.1 to 0.3 Mbit/s each, and that no longer grows with the number of bullets on screen. Protocol v1 sent every entity plus the last 160 effects in every snapshot, which reached about 37 Mbit/s per player late in a run. `npm run bench:net` prints before and after numbers for several builds from the same simulation.

How the client draws the match:

- Your ship moves immediately and reconciles by replaying unacknowledged input frames. Inputs carry sequence numbers and run epochs; duplicates and stale-run inputs are ignored.
- Your bullets appear the moment you fire. The client runs the authority's exact per-frame cooldown, so the predicted volley is the one the server fires, and it adopts the server's ids when the journal confirms it.
- Enemies and enemy shots are drawn on your local clock: where they will be when the authority processes your current input. The shots you see reaching you are the ones the authority tests against your ship.
- Other pilots and their bullets are interpolated. The buffer adapts to measured jitter, from about 50 ms on a clean connection up to 250 ms.
- Damage stays authoritative. Swept relative-motion collision checks stop fast projectiles skipping through targets between ticks. Every hit still carries the shooter's color, target and damage, so all players see impact flashes and damage numbers.
- Prediction cannot remove latency from confirmed damage, and there is no server rewind or lag compensation, so a host near the squad still helps.

Clients and authorities compare protocol versions when joining, so an old downloaded `voidrunner.html` gets an "out of date" message instead of a broken match.

## Host the server on your own laptop

```sh
npm ci
npm start
ngrok http 3000
```

In the GitHub Pages lobby choose **Dedicated server**, open Server connection, and enter the HTTPS forwarding URL shown by ngrok. Friends use that same URL and room code. No router port-forwarding is needed for an ngrok HTTP tunnel. Your laptop must stay awake with both processes running. A tunnel adds a routing hop and is not automatically faster than a nearby cloud server. Keep the service at Render as an alternative; do not replace it until you compare the lobby ping while playing.

ngrok WebSocket documentation: https://ngrok.com/docs/using-ngrok-with/websockets
WebRTC connectivity: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity

## Play

- **Solo:** open `index.html` locally or on GitHub Pages, then Launch Run.
- **Online:** open the deployed game, select **Online Co-op**, create a room, and share the six-character code. Friends join using the same server. The host launches with 1–4 pilots.
- Arrow keys move; hold Space to fire; 1/2/3 choose an upgrade.
- Each pilot picks their own upgrade. The next sector starts after everyone chooses.
- Stay within 55 game pixels of a downed pilot for 3 seconds to revive them. Downed pilots also return when a sector clears.
- Boss every fifth sector. Enemy health and wave size scale with squad size. All pilots down means run over.
- Online play never pauses. Leaving, switching tabs, or losing focus clears movement input. In dedicated-server mode, if the host leaves, another pilot becomes lobby host. In direct mode, host departure ends the room.
- Touch controls and optional sound are available.

## Run the server locally

Requires Node.js 22 or later.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. The same server serves the game and its WebSocket connection. For a local network test, other devices can use the machine's LAN address and port 3000, subject to your firewall.

## Deploy online with Render

The repository includes `render.yaml` for a single Node web service.

1. In Render, choose **New → Blueprint**, connect this repository, and deploy the included configuration. Review the selected plan before creating the service.
2. Open the resulting HTTPS service URL. It serves the complete game and the multiplayer server together. Create a room and share that URL and room code with friends.

Alternatively, create a Node Web Service with build command `npm ci`, start command `npm start`, and health check `/health`.

Render documentation: https://render.com/docs/deploy-node-express-app and https://render.com/docs/websocket.

### Keep GitHub Pages as the frontend

In repository Settings → Pages, select **Deploy from a branch → main → / (root)**.

Set `window.VOIDRUNNER_SERVER` in `config.js` to your server's HTTPS origin, such as `https://your-service.onrender.com`. Players then do not need to enter a server address. Until configured, the lobby has a Server connection field. You may also supply a `?server=https://your-service.onrender.com` URL parameter.

GitHub Pages alone cannot run the multiplayer server. HTTPS pages require secure WebSockets (`wss://`); the client converts an HTTPS server URL automatically.

## Architecture and limits

- The match authority (browser host or server) owns the simulation. Guests send only controls and choices. A browser host is trusted and can modify its own simulation; this is casual co-op, not anti-cheat infrastructure.
- Guests predict movement and their own volleys, and reconcile against the match authority. Other pilots use buffered snapshot interpolation.
- Maximum four pilots per room. New joins are lobby-only. Disconnected pilots leave immediately, and an empty room is deleted. Reconnecting into an active run is not implemented.
- Rooms live in memory on **one server instance**. Server restarts/deploys lose active runs. Do not horizontally scale this version.
- Room codes are invite codes, not accounts or authentication. Use for casual co-op. Input message limits, payload limits, connection limits, room limits, and heartbeat cleanup are included.
- Free hosting can sleep when idle. Initial connection may be slow. Runs are not persisted.
- Solo gameplay remains in `game.js`; online rendering/lobby in `online.js`; shared authoritative gameplay in `shared/engine.js`, the wire format in `shared/protocol.js` and peer transport in `peer.js`; HTTP/WebSocket transport in `server/index.js`.

## Tests

```sh
npm test
```

The suite connects four real WebSocket clients, rejects a fifth, checks host-only launching and handoff, movement and shots, cleanup, revives, upgrades, defeat/restart, boss scaling, stale inputs, and static-file exposure. Netcode tests hold bandwidth budgets for several builds, check that client-computed projectiles match the authority (also across lost messages and resyncs), and check that local fire prediction matches the authority volley for volley. `npm run test:browser` runs four real browsers in both modes against the Node server and the local Cloudflare runtime. GitHub Actions runs it on pushes and pull requests. Manual browser playtesting with four people is still recommended.
