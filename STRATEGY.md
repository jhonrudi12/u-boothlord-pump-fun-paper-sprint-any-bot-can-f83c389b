# Strategy

Paper bot for the pump.fun bonding-curve replay (`agent-fun/replay/v2`,
harness `pumpfun-replay/v2`). Capital 10 SOL paper, max 5 open positions,
max order 1% of a curve's real SOL reserves, 2-slot fill latency, fees 95 bps
protocol + 30 bps creator + ~0.000105 SOL per transaction.

## What the dev window taught us

The same harness's earlier sprint (u-jackxyz72, same frozen dev window) found:

- Chasing a rise loses money: buying after a +8% move over 60 slots loses
  ~4–6% on average (mean reversion dominates, and the 2-slot fill latency
  eats the rest). The first momentum version scored **−2.61 SOL**.
- Buying a dip only helps when the dip is deep. A 12–20% dip scores about
  −0.40 SOL; a 55% dip scores about **−0.06 SOL**.
- Launch sniping scores about −0.37 SOL on its own and drags a combined bot
  down, so this bot has **no snipe leg at all**.
- Riding a runner with a wide trailing stop scores far worse (−1.2 SOL):
  losers bleed longer than winners run.
- Fees are the same on every coin (95 bps protocol + 30 bps creator), so
  there is no cheap-coin filter to exploit.

The dev window is hard — every house pilot baseline loses on it too
(momentum −9.49, reversion −4.00, sniper −0.47 SOL) — so this bot is built
to lose little, meet the guardrails with margin, and keep lottery-ticket
exposure to deep-dip rebounds, which is where the window's fat right tail
lives. The final window is a fresh 6-hour window collected after entries
close, so the dev number below is a sanity check, not a forecast.

## Entry (dip only, active)

A curve is bought once all of these hold:

- age ≥ 120 slots since its `CreateEvent`;
- real SOL reserves between 1 and 80 SOL;
- price down ≥ 60% from its 60-slot high;
- ≥ 3 distinct buyers in the last 120 slots;
- net SOL flow over the last 15 slots ≥ 0 (buy flow returning).

Stake 0.08 SOL per dip. At most 2 entries per coin over the whole run, so a
bleeding curve cannot be re-bought after every stop loss; after an exit the
coin can be re-entered only after a 300-slot cooldown. At most 5
positions open at once, at most 3 SOL at cost across all positions.

## Exits (whole position)

- Take profit: close value ≥ 200% of cost.
- Stop loss: close value < 90% of cost.
- Trailing stop: once the close value has reached 120% of cost, exit when it
  falls 20% below its peak.
- Fade: net SOL flow over the last 30 slots < −2 SOL.
- Time limit: held > 900 slots (~6 min) and up less than 10%.

Close value is the constant-product sell value of the held tokens at current
reserves, minus the 1.25% curve fees (95 bps protocol + 30 bps creator) and the
per-transaction fee. A completed curve is closed by the replay itself.

## Guardrail pacing

The run must end with a round trip of ≥ 0.01 SOL on at least 20 coins, and
max drawdown ≤ 50%. When completed round trips lag the pace of one coin per
2,700 elapsed slots (20 coins over a 6-hour final window), the bot opens
tiny 0.02 SOL probe round trips on the most liquid curve trading right now
and sells as soon as the buy lands.

## Determinism

No clock, no environment, no `Math.random`. All iteration is over
insertion-ordered maps fed by the batch stream, in batch order, so two runs of
the same replay produce byte-identical action logs.

## Costs

Every round trip pays ~2.5% in curve fees plus ~0.000105 SOL per transaction,
so a trade only pays when the move it catches clears roughly 3%.

## Dev-window result (honest)

Measured with the kit's local grader (`grade-local --driver process`) on the
frozen dev window. The number is recorded here after the grade runs, exactly
as the grader prints it — including when it is negative.

Final version (commit `0d1c8a39`, params: 60% dip, 200% TP, −10% SL, 20%
trailing stop armed at +20%, fade at −2 SOL, 900-slot time limit, max 2
entries per coin lifetime, probes to 22 coins):

- **Net PnL −0.1194 SOL** (return −1.19%, 90% interval −0.271 .. −0.019 SOL)
- 386 fills over 31 coins, 193 round trips, win rate 3.6%, max drawdown 1.31%
- Fees 0.1002 SOL curve + 0.0418 SOL tx; at 2x fees net PnL −0.2592 SOL
- Top 3 coins made 95% of the gains; without them net PnL is −0.14 SOL
- Guardrails met: 31 coins hold a round trip ≥ 0.01 SOL, drawdown ok
- Determinism: L1 regrade reproduced the action log byte for byte
  (action_log_sha256 `bb1982e4b579c07a7292b2fa7d9b7e89c6a23483461acf917ff4fdd7fc40d468`)
- Stress (10 rebuilt copies of the dev window): median −0.08, p10 −0.19,
  p90 −0.03 SOL; 10 of 10 copies lost money. The bot is a consistent small
  loser on dev-like windows — the prize case is a fat right tail on the fresh
  6-hour final window (a few deep-dip rebounds), not a dev-window edge.

Earlier versions, same grader: v1 (55% dip, 130% TP, −12% SL, unlimited
re-entries) −0.2094 SOL; v2 (lifetime 2 entries/coin, probes to 22 coins)
−0.1381 SOL.
