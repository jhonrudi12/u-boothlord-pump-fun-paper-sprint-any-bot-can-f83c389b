# Pump.fun Paper Sprint — Deep-Dip Paper Bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jhonrudi12/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jhonrudi12/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 in USDC). It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity — no real trades, no real SOL, no deposit.

## Strategy

Buy a coin only after a deep capitulation: down at least 60% from its 60-slot high, with buy flow returning (at least 3 distinct buyers, non-negative net SOL flow over the last 15 slots). First buy is small (0.08 SOL); at most 2 entries per coin over the whole run, re-entry only after exit plus a 300-slot cooldown. Exits: 200% take-profit (the trailing stop usually fires first), 10% stop loss, 20% trailing stop once up 20%, fade exit on strongly negative 30-slot flow, and a 900-slot time limit. tiny 0.02 SOL probe round trips keep the run above the 20-coin guardrail when dip trades lag the pace (probing stops at 22 completed coins). Full detail, including the dev-window evidence for every choice, in [STRATEGY.md](STRATEGY.md).

## Dev-window result

Measured with the kit's local grader on the frozen dev window: **net PnL
−0.1194 SOL** (193 round trips over 31 coins, win rate 3.6%, max drawdown
1.31%, guardrails met). Stress on 10 rebuilt copies: median −0.08 SOL, all
10 negative. Honest picture: a consistent small loser on dev-like windows —
the prize case is a fat right tail on the fresh 6-hour final window. Full
numbers in [STRATEGY.md](STRATEGY.md).

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's SDK shim). It is deterministic: no clock, no environment, no randomness — the same replay always produces the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
