# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/robyaryansah42-art/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/robyaryansah42-art/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed snapshot of every protocol DefiLlama tracks, ranks the pre-token ones by what their launch would be worth, and hands in a web dashboard with the board, a detail view for each protocol and the steps to farm it.

The model (radar-2) prices each protocol off the market itself: the ratio for a category is the median market-cap-to-TVL of the snapshot's own live-token protocols in that category (at least 3 peers, clamped to 0.05–1.0x; fewer peers fall back to the global median), adjusted for seven-day growth, for how long the protocol has run with no token, and for how many chains it runs on. The board covers all 40 watchlist protocols plus every eligible pre-token protocol below the watchlist floor; the live-token protocols are set aside with their market caps shown. No protocol name is special-cased.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

That writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json` from the sealed snapshot. Node.js 22.18 or later, standard library only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sxjvzha4&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
