# 🎲 Ludo Live

## ▶ Play now

| Link | Note |
|---|---|
| **[Play on link 1](https://5824eb1f1d1cdf.app.lhr.life)** | Use this one if link 2 doesn't open on your network |
| **[Play on link 2](https://spell-generic-anytime-fraser.trycloudflare.com)** | Some mobile networks in India block this domain |

Open a link, type your name, tap a button and you're in.

> Both links run from a home machine for now. They go down when it sleeps and change when the tunnel restarts.
> A permanent address comes with the Render deploy.

Live 4-player Ludo with a built-in video or audio call. Play with friends through an invite link,
or hit "Play online" and get matched with anyone. If nobody's around, bots join so you never wait long.

## What you get

- **Video, audio or music only.** Your call runs peer to peer, straight between players.
- **3D dice** that tumbles and lands on the real result, plus a glow on the yard of whoever's turn it is.
- **Virtual coins.** Start with 1000, claim 500 free every day, pick a table (free, 100, 500, 2500) and the winner takes the pot.
- **Token shop** with 12 skins, from Glass and Neon to Galaxy and Diamond, bought with coins.
- **Emotes** like 😂 👏 🔥 😡 and quick lines such as "Jaldi chalo!" or "Badla lunga!".
- **Matchmaking** by table size. Four players start at once, two or three after 12 seconds, and a solo player gets three bots after 15.
- **Effects and sound.** Tokens hop square by square, cuts blast and shake the board, and wins get a trophy with confetti.
- **Background music** in three moods (chill, desi beat, arcade), all generated in the browser.

Coins are play money only. You can't buy them and you can't cash them out.

## How to play

1. Open the link and enter your name.
2. Pick a call mode and a table.
3. Tap **Create room for friends** and share the invite link, or tap **Play online with anyone**.
4. Roll with the dice button or the Space key, then tap a glowing token (or press 1 to 4).

Rules:

- Roll a 6 to open a token. Three 6s in a row and you lose the turn.
- Land on an opponent to cut it, except on stars and start squares.
- A 6, a cut or a token reaching home gives you another roll. You need the exact number to finish.
- Each turn has 30 seconds. Miss it and the best move is played for you.

## Run it yourself

    docker compose up -d --build app                 # http://localhost:3000
    docker compose --profile public up -d tunnel     # temporary public https link
    docker compose logs tunnel | grep trycloudflare

Coins and skins are stored in the `ludo-data` Docker volume.

### Run on a Windows laptop

1. Install Node.js and cloudflared once, in PowerShell:

       winget install OpenJS.NodeJS.LTS
       winget install Cloudflare.cloudflared

2. On GitHub open this repo, then Code, then Download ZIP, and extract it.
3. Double-click `start-windows.bat`.
4. Share the `https://....trycloudflare.com` link it prints. Keep both windows open.

### Deploy on Render

`render.yaml` is ready. In Render go to New, then Blueprint, pick this repo and apply.
On the free plan the server sleeps after 15 idle minutes and coins reset on restart.

## Tests

    docker build --target test .                     # 38 unit and integration tests
    docker compose --profile e2e run --rm e2e        # 4 real Chrome players with fake camera and mic

The end-to-end run checks that every player hears the other three and sees the video players.
It also checks that coins, the shop, emotes and matchmaking work and that there are no console errors.
Screenshots and results land in `e2e/out/`.

## Security

- The server rolls every dice and checks every move. Clients only send requests.
- Every socket message is validated and rate limited per connection and per IP.
- Call signals only travel between players in the same room, and unknown fields are stripped.
- Strict Content Security Policy, no inline scripts, no framing, no referrer.
- Socket connections from other websites are refused.
- The container runs as a non-root user on a read-only filesystem with every capability dropped.

## Mobile data trouble

If players on mobile data can't see each other, add a TURN server:

    TURN_URL=turn:host:3478 TURN_USER=x TURN_PASS=y docker compose up -d app
