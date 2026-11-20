# Ludo Live

Live 4-player Ludo with a built-in video/audio call, online matchmaking with bots, virtual coins, a token skin shop, emotes and background music.

## Run with Docker

    docker compose up -d --build app                 # http://localhost:3000
    docker compose --profile public up -d tunnel     # public https link
    docker compose logs tunnel | grep trycloudflare  # print the link

Wallets live in the `ludo-data` volume, so coins and skins survive restarts.

## Test

    docker build --target test .                     # 38 unit + integration tests
    docker compose --profile e2e run --rm e2e        # 4 real Chrome players, fake camera/mic

The e2e run saves screenshots and `results.json` into `e2e/out/`.

## Game

- Roll 6 to open a token. Three 6s in a row loses the turn.
- Landing on an opponent cuts it, except on stars and start squares.
- Extra roll on a 6, a cut, or a token reaching home. Exact roll to finish.
- 30 second turn timer. If you don't play, the best move is played for you.

## Coins

Everyone starts with 1000 virtual coins and can claim 500 free once a day.
Tables cost 0, 100, 500 or 2500 to enter and the winner takes the whole pot.
Coins can't be bought or cashed out. They're only for fun and for the skin shop.

## Play online

"Play online with anyone" puts you in a queue for your table size. Four players start right away,
two or three start after 12 seconds, and if you're alone for 15 seconds three bots join.
With strangers the mic and camera start off, free-text chat doesn't exist, and every tile has a mute button.

## Security

- Server decides every dice roll and move. Clients only send intents.
- All socket input is validated and rate limited, per socket and per IP.
- WebRTC signals are only relayed between players in the same room, with SDP fields whitelisted.
- Strict CSP, no inline scripts, frame blocking, nosniff, no referrer.
- Cross-origin socket connections are refused.
- Container runs as a non-root user on a read-only filesystem with all capabilities dropped.

## TURN

If players on mobile data can't see each other, add a TURN server:

    TURN_URL=turn:host:3478 TURN_USER=x TURN_PASS=y docker compose up -d app
