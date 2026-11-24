// Pump.fun Paper Sprint — deep-dip paper bot for agent-fun/replay/v2.
//
// The dev window is brutal: chasing rises loses money, every house pilot
// baseline loses on it, and even the best simple leg (buying a deep dip)
// scores slightly negative. So this bot is built to lose little, meet the
// guardrails with margin, and keep lottery-ticket exposure to deep-dip
// rebounds, which is where the window's fat right tail lives.
//
// Entry (dip only): a curve is bought once its price is down 55% or more
// from its 60-slot high, it is at least 120 slots old, its real SOL reserves
// sit between 1 and 80 SOL, at least 3 distinct buyers traded it recently,
// and net SOL flow over the last 15 slots is not negative (buy flow
// returning). Stake 0.08 SOL per dip, at most 2 entries per coin.
//
// Exits (whole position): 30% take profit, 12% stop loss, a 15% trailing
// stop once up 10%, a fade exit on negative 30-slot flow, and a 600-slot
// time limit when up less than 10%.
//
// Guardrail pacing: the run must end with a round trip of at least 0.01 SOL
// on at least 20 coins. When completed round trips lag the pace implied by
// elapsed slots, the bot opens tiny 0.02 SOL probe round trips on the most
// liquid curve trading right now and sells as soon as the buy lands.
//
// Deterministic: no clock, no environment, no randomness. All iteration is
// over insertion-ordered maps fed by the batch stream, in batch order, so two
// runs of the same replay produce byte-identical action logs. The bot speaks
// agent-fun/replay/v2 through the vendored SDK shim (vendor/makefun-bot.ts).

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface StrategyParams {
  /** Dip depth in bps of the 60-slot high: 5500 = down 55%. */
  dipBps: number;
  /** Window (slots) the dip high is taken over. */
  highWindowSlots: number;
  /** Minimum curve age in slots before the first entry. */
  minAgeSlots: number;
  /** Real SOL reserve band a curve must sit in to be bought. */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  /** Minimum distinct buyers in the recent-trade window. */
  minBuyers: number;
  /** Recent-trade window (slots) for the buyer count. */
  buyerWindowSlots: number;
  /** Net-flow window (slots) that must be non-negative at entry. */
  entryFlowWindowSlots: number;
  /** SOL per dip entry. */
  stakeLamports: bigint;
  /** Maximum filled buys per coin. */
  maxEntriesPerCoin: number;
  /** Slots to wait after an exit before re-entering the same coin. */
  cooldownSlots: number;
  /** Maximum open positions (harness cap is 5). */
  maxPositions: number;
  /** Maximum total cost across open positions. */
  maxCostLamports: bigint;
  /** Take profit: close value / cost at or above this (bps). */
  takeProfitBps: number;
  /** Stop loss: close value / cost below this (bps). */
  stopLossBps: number;
  /** Trailing stop arms once close value / cost reaches this (bps). */
  trailArmBps: number;
  /** Trailing stop: exit when the ratio falls this far (bps) below its peak. */
  trailDropBps: number;
  /** Fade exit: net SOL flow over this window (slots) below this (SOL). */
  fadeWindowSlots: number;
  fadeFlowSol: number;
  /** Time limit (slots) for a position that is not up enough. */
  timeLimitSlots: number;
  /** "Up enough" to survive the time limit (bps of cost). */
  timeLimitKeepBps: number;
  /** Size of a guardrail probe round trip. */
  probeLamports: bigint;
  /** Pace: one completed round-trip coin per this many elapsed slots. */
  probePaceSlots: number;
  /** Stop probing once this many coins have completed a round trip. */
  probeTargetCoins: number;
  /** Hard cap on orders in one batch reply (harness cap is 16). */
  maxOrdersPerBatch: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  dipBps: 6000, // v3: deeper dip — fewer, more capitulated entries
  highWindowSlots: 60,
  minAgeSlots: 120,
  minRealSolLamports: LAMPORTS_PER_SOL,
  maxRealSolLamports: 80n * LAMPORTS_PER_SOL,
  minBuyers: 3,
  buyerWindowSlots: 120,
  entryFlowWindowSlots: 15,
  stakeLamports: (8n * LAMPORTS_PER_SOL) / 100n,
  maxEntriesPerCoin: 2,
  cooldownSlots: 300,
  maxPositions: 5,
  maxCostLamports: 3n * LAMPORTS_PER_SOL,
  takeProfitBps: 20000, // v3: let the rare runners run; the trailing stop does the work
  stopLossBps: 9000, // v3: cut losers at -10% instead of -12%
  trailArmBps: 12000,
  trailDropBps: 2000, // v3: 20% below peak — more room for runners
  fadeWindowSlots: 30,
  fadeFlowSol: -2, // v3: only exit on a clearly fading tape
  timeLimitSlots: 900,
  timeLimitKeepBps: 11000,
  probeLamports: (2n * LAMPORTS_PER_SOL) / 100n,
  probePaceSlots: 2700,
  probeTargetCoins: 22, // guardrail is 20; a little margin, no more
  maxOrdersPerBatch: 12,
};

/** One price sample: the curve's price right after a trade on it. */
interface PriceSample {
  slot: number;
  price: number;
}

/** One trade seen on a curve, for flow and buyer counts. */
interface TradeNote {
  slot: number;
  user: string;
  buy: boolean;
  sol: number;
}

interface Tape {
  /** Slot the curve was first seen (CreateEvent slot when known). */
  firstSlot: number;
  samples: PriceSample[];
  trades: TradeNote[];
  /** Filled buys so far on this coin, lifetime (never reset: a coin gets at
   * most maxEntriesPerCoin buys in the whole run, so a bleeding curve cannot
   * be re-bought over and over after every stop loss). */
  entries: number;
  /** SOL spent on filled buys since the last full close (lamports). */
  openBoughtLamports: bigint;
  /** Slot of the last exit (position fully closed), -1 when never. */
  lastExitSlot: number;
  /** Best close-value / cost ratio seen while holding, 0 when flat. */
  peakRatioBps: number;
  /** Slot the current position was opened, -1 when flat. */
  entrySlot: number;
  /** True while this coin is a guardrail probe (sell as soon as it fills). */
  probe: boolean;
}

function newTape(slot: number): Tape {
  return {
    firstSlot: slot,
    samples: [],
    trades: [],
    entries: 0,
    openBoughtLamports: 0n,
    lastExitSlot: -1,
    peakRatioBps: 0,
    entrySlot: -1,
    probe: false,
  };
}

/** Price of one token in SOL, from post-trade virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/**
 * Constant-product sell value of `tokens` at the curve's current virtual
 * reserves, minus the 1.25% curve fees (95 bps protocol + 30 bps creator)
 * and one transaction fee. 0 when the sale would not cover its tx fee.
 */
function closeValueLamports(
  state: BotState,
  mint: Pubkey,
  tokens: bigint,
): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || tokens <= 0n) return 0n;
  const vt = curve.virtual_token_reserves;
  const vq = curve.virtual_quote_reserves;
  if (vt <= 0n || vq <= 0n) return 0n;
  const out = (vq * tokens) / (vt + tokens);
  const afterFees = (out * 9875n) / 10000n;
  const tx = state.txFeeLamports();
  return afterFees > tx ? afterFees - tx : 0n;
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const roundTripped = new Set<Pubkey>();
  let firstSlot = -1;
  let lastSlot = -1;

  function tapeFor(mint: Pubkey, slot: number): Tape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = newTape(slot);
      tapes.set(mint, tape);
    }
    return tape;
  }

  /** Drop tape older than the longest window we ever read (1200 slots). */
  function prune(tape: Tape, slot: number): void {
    const floor = slot - 1200;
    while (tape.samples.length > 0 && tape.samples[0].slot < floor) tape.samples.shift();
    while (tape.trades.length > 0 && tape.trades[0].slot < floor) tape.trades.shift();
  }

  function netFlowSol(tape: Tape, slot: number, windowSlots: number): number {
    let flow = 0;
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const t = tape.trades[i];
      if (t.slot <= slot - windowSlots) break;
      flow += t.buy ? t.sol : -t.sol;
    }
    return flow;
  }

  function distinctBuyers(tape: Tape, slot: number, windowSlots: number): number {
    const buyers = new Set<string>();
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const t = tape.trades[i];
      if (t.slot <= slot - windowSlots) break;
      if (t.buy) buyers.add(t.user);
    }
    return buyers.size;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      lastSlot = slot;
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      const minBuy = 10_000_000n; // 0.01 SOL: the guardrail's round-trip floor

      // --- Fold this batch's fills into the tapes (entries, exits). ---
      for (const fill of batch.fills) {
        if (fill.client_id.startsWith('_')) continue; // harness closes
        const tape = tapes.get(fill.mint);
        if (tape === undefined) continue;
        if (fill.side === 'buy' && fill.status === 'filled') {
          tape.entries += 1;
          tape.openBoughtLamports += BigInt(fill.quote_lamports);
          if (tape.entrySlot < 0) tape.entrySlot = slot;
        }
      }

      // --- Fold this batch's events into the tapes (prices, flow). ---
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          const tape = tapeFor(event.mint, event.slot);
          tape.firstSlot = event.slot;
          continue;
        }
        if (event.event !== 'TradeEvent') continue;
        const tape = tapeFor(event.mint, event.slot);
        const price = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        if (price > 0) tape.samples.push({ slot: event.slot, price });
        tape.trades.push({
          slot: event.slot,
          user: event.user,
          buy: event.is_buy,
          sol: Number(BigInt(event.sol_amount)) / 1_000_000_000,
        });
        prune(tape, slot);
      }

      // --- Notice fully closed positions: round trips and cooldowns. ---
      for (const [mint, tape] of tapes) {
        if (tape.openBoughtLamports >= minBuy && !state.positions.has(mint) && !hasPendingSell(state, mint)) {
          if (tape.entries > 0) {
            roundTripped.add(mint);
            tape.lastExitSlot = slot;
            tape.peakRatioBps = 0;
            tape.entrySlot = -1;
            tape.probe = false;
            tape.openBoughtLamports = 0n;
          }
        }
      }

      // --- Exits first: every held position is checked against all rules. ---
      let totalCost = 0n;
      for (const holding of state.positions.values()) totalCost += holding.cost_lamports;
      for (const [mint, holding] of state.positions) {
        if (orders.length >= params.maxOrdersPerBatch) break;
        const tape = tapes.get(mint);
        const close = closeValueLamports(state, mint, holding.token_amount);
        const cost = holding.cost_lamports;
        if (cost <= 0n) continue;
        const ratioBps = Number((close * 10000n) / cost);
        if (tape !== undefined) {
          if (ratioBps > tape.peakRatioBps) tape.peakRatioBps = ratioBps;
          // A probe sells the moment its buy has landed.
          if (tape.probe && !hasPendingSell(state, mint)) {
            orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10000 });
            continue;
          }
          const flow30 = netFlowSol(tape, slot, params.fadeWindowSlots);
          const heldSlots = tape.entrySlot >= 0 ? slot - tape.entrySlot : 0;
          const exit =
            ratioBps >= params.takeProfitBps ||
            ratioBps < params.stopLossBps ||
            (tape.peakRatioBps >= params.trailArmBps &&
              ratioBps <= tape.peakRatioBps - params.trailDropBps) ||
            flow30 < params.fadeFlowSol ||
            (heldSlots > params.timeLimitSlots && ratioBps < params.timeLimitKeepBps);
          if (exit && !hasPendingSell(state, mint)) {
            orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10000 });
          }
        }
      }

      // --- Entries: deep dips with buy flow returning. ---
      let free = state.freeCashLamports();
      let slots = params.maxPositions - state.committedPositionCount();
      for (const [mint, curve] of state.curves) {
        if (orders.length >= params.maxOrdersPerBatch) break;
        if (slots <= 0) break;
        if (curve.complete) continue;
        if (state.positions.has(mint) || hasPendingBuy(state, mint)) continue;
        const tape = tapes.get(mint);
        if (tape === undefined) continue;
        if (tape.entries >= params.maxEntriesPerCoin) continue;
        if (tape.lastExitSlot >= 0 && slot - tape.lastExitSlot < params.cooldownSlots) continue;
        const created = curve.created_slot ?? tape.firstSlot;
        if (slot - created < params.minAgeSlots) continue;
        const realSol = curve.real_quote_reserves;
        if (realSol < params.minRealSolLamports || realSol > params.maxRealSolLamports) continue;
        prune(tape, slot);
        if (tape.samples.length < 2) continue;
        let high = 0;
        let lastPrice = 0;
        for (const s of tape.samples) {
          if (s.slot <= slot - params.highWindowSlots) continue;
          if (s.price > high) high = s.price;
          lastPrice = s.price;
        }
        if (high <= 0 || lastPrice <= 0) continue;
        const dipBps = Math.floor(((high - lastPrice) / high) * 10000);
        if (dipBps < params.dipBps) continue;
        if (distinctBuyers(tape, slot, params.buyerWindowSlots) < params.minBuyers) continue;
        if (netFlowSol(tape, slot, params.entryFlowWindowSlots) < 0) continue;
        const cap = state.maxBuyLamports(mint);
        let amount = params.stakeLamports;
        if (amount > cap) amount = cap;
        if (amount < minBuy) continue;
        if (totalCost + amount > params.maxCostLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10000 });
        free -= amount + tx;
        totalCost += amount;
        slots -= 1;
      }

      // --- Guardrail pacing: probe round trips when coins lag the pace. ---
      const elapsed = firstSlot < 0 ? 0 : slot - firstSlot;
      const paceTarget = Math.floor(elapsed / params.probePaceSlots);
      const openProbes = [...tapes.values()].filter((t) => t.probe && t.entries > 0).length;
      if (
        roundTripped.size + openProbes < Math.min(paceTarget, params.probeTargetCoins) &&
        roundTripped.size < params.probeTargetCoins &&
        orders.length < params.maxOrdersPerBatch &&
        slots > 0
      ) {
        let bestMint: Pubkey | null = null;
        let bestReal = 0n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete) continue;
          if (state.positions.has(mint) || hasPendingBuy(state, mint)) continue;
          const tape = tapes.get(mint);
          if (tape === undefined || tape.trades.length === 0) continue;
          if (tape.trades[tape.trades.length - 1].slot <= slot - 30) continue;
          if (curve.real_quote_reserves < 2n * LAMPORTS_PER_SOL) continue;
          if (curve.real_quote_reserves > bestReal) {
            bestReal = curve.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          let amount = params.probeLamports;
          if (amount > cap) amount = cap;
          if (amount >= minBuy && free >= amount + tx) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: 10000 });
            tapeFor(bestMint, slot).probe = true;
          }
        }
      }

      return orders;
    },
  };
}
