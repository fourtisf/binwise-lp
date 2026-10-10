import {
  DEFAULT_STRATEGY,
  validateStrategy,
  type CycleDecision,
  type CycleState,
  type CycleStep,
  type Decision,
  type DecisionType,
  type DemoEvent,
  type DepositAsset,
  type PerformanceRange,
  type PerformanceSeries,
  type PoolDetail,
  type PoolRow,
  type PositionView,
  type StrategySettings,
  type StreamEvent,
  type VaultLive,
  type VaultMode,
  type VaultOverview,
} from '@binwise/core';
import { DEMO_PAIRS, POOLS, POSITIONS, TOKENS, fmtMcap, pairName, poolDetail, poolRow, type MockPosition } from './data';
import { PriceSim } from './price-sim';
import { gauss, rng, walk } from './random';

export class MockError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface EngineOptions {
  tickMs?: number;
  cycleMs?: number;
  stepMs?: number;
  liveTradingEnabled?: boolean;
  random?: () => number;
  now?: () => number;
}

const STEPS: CycleStep[] = [
  { title: 'Scan', running: 'Reading 214 DLMM pools', done: '214 pools, 38 passed filters' },
  { title: 'Score', running: 'Ranking eligible pools', done: 'Top: JUP / SOL 82, SOL / USDC 77' },
  { title: 'Check positions', running: 'Comparing price to ranges', done: '' },
  { title: 'Decide', running: 'Weighing fees against cost', done: '' },
  { title: 'Execute', running: 'Sending to Solana', done: '' },
];

const usd = (n: number, d = 0) =>
  (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const amount = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Listener = (e: StreamEvent) => void;

interface LivePosition {
  def: MockPosition;
  sim: PriceSim;
}

/**
 * A simulated paper vault that behaves like the prototype: prices tick every
 * 1.4s, the agent runs a 5-step cycle, and every action lands in the feed.
 * It stands in for the real API until the data collector and agent exist.
 */
export class MockEngine {
  readonly vaultId = 'main';
  private opts: Required<EngineOptions>;
  private listeners = new Set<Listener>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private positions: LivePosition[];
  private decisions: Decision[] = [];
  private seq = 0;
  private strategy: StrategySettings = structuredClone(DEFAULT_STRATEGY);
  private vault = { value: 11445.2, openValue: 11348, fees30d: 1303.4, net: 6.8, paused: false, mode: 'paper' as VaultMode, cycle: 1284 };
  private assets: DepositAsset[] = [
    { ...TOKENS.SOL, priceUsd: 182.46, balance: 42.8 },
    { ...TOKENS.USDC, priceUsd: 1, balance: 3120 },
  ];
  private cycle: CycleState;
  private cycleStartedAt = 0;
  private started = false;

  constructor(opts: EngineOptions = {}) {
    this.opts = {
      tickMs: 1400,
      cycleMs: 9000,
      stepMs: 900,
      liveTradingEnabled: false,
      random: Math.random,
      now: Date.now,
      ...opts,
    };
    this.positions = POSITIONS.map((def) => ({ def, sim: new PriceSim(def.sim) }));
    this.cycle = { cycle: this.vault.cycle, step: -1, paused: false, intervalMs: this.opts.cycleMs, elapsedMs: 0, steps: STEPS };
    const seed: [DecisionType, string, string, boolean][] = [
      ['scan', 'Scanned 214 pools', '38 passed filters. Top score JUP / SOL at 82.', false],
      ['deploy', 'Deployed $2,200 to PENGU / SOL', 'Score 71, trend +6.8%, inside the 25% pool cap.', true],
      ['exit', 'Closed WIF / SOL', '7-day trend −14.6% broke your −12% exit rule. 5,210 USDC returned.', true],
      ['compound', 'Compounded $41.80 in fees', 'Claimed from JUP / SOL and added back to the same bins.', true],
      ['rebalance', 'Rebalanced SOL / USDC', 'Price left range by 2 bins. Expected fees beat cost 22x.', true],
    ];
    seed.forEach(([type, title, reason, tx]) => this.addDecision(type, title, reason, tx, false));
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs));
    this.timers.push(
      setInterval(() => {
        if (!this.vault.paused && this.opts.now() - this.cycleStartedAt >= this.opts.cycleMs) this.runCycle();
      }, 200),
    );
    this.runCycle();
    return this;
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.started = false;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StreamEvent) {
    this.listeners.forEach((fn) => fn(e));
  }

  // ---------- reads ----------

  getOverview(): VaultOverview {
    return {
      id: this.vaultId,
      name: 'Main vault',
      mode: this.vault.mode,
      status: this.vault.paused ? 'paused' : 'running',
      cycle: this.vault.cycle,
      value: this.vault.value,
      openValue: this.vault.openValue,
      fees30d: this.vault.fees30d,
      netVsHold30d: this.vault.net,
      timeInRange30d: 93,
      spark: walk(77, 30, 0.0015, 0.006, 100),
      depositAssets: this.assets.map((a) => ({ ...a })),
    };
  }

  getPerformance(range: PerformanceRange): PerformanceSeries {
    const n = range + 1;
    const hold = walk(range * 3 + 1, n, 0.0003, 0.016, 10000);
    const r = rng(range);
    const vault = hold.map((v, i) => v * (1 + 0.068 * (range / 30) * (i / (n - 1)) + 0.002 * gauss(r)));
    const k = this.vault.value / vault[n - 1];
    const now = this.opts.now();
    return {
      range,
      ts: hold.map((_, i) => now - (n - 1 - i) * 864e5),
      vault: vault.map((v) => v * k),
      hold: hold.map((v) => v * k),
    };
  }

  getPools(): PoolRow[] {
    return POOLS.map((p) => poolRow(p, this.strategy)).sort((a, b) => b.score - a.score);
  }

  getPool(id: string): PoolDetail {
    const p = POOLS.find((x) => x.id === id);
    if (!p) throw new MockError('not_found', 'No pool with that id.', 404);
    return poolDetail(p, this.strategy);
  }

  getPositions(): PositionView[] {
    return this.positions.map((p) => this.positionView(p));
  }

  getDecisions(type?: DecisionType): Decision[] {
    return type ? this.decisions.filter((d) => d.type === type) : [...this.decisions];
  }

  getStrategy(): StrategySettings {
    return structuredClone(this.strategy);
  }

  getCycle(): CycleState {
    return { ...this.cycle, elapsedMs: this.vault.paused ? 0 : this.opts.now() - this.cycleStartedAt };
  }

  // ---------- writes ----------

  putStrategy(s: StrategySettings): StrategySettings {
    const errors = validateStrategy(s);
    if (errors.length) throw new MockError('invalid_strategy', errors.join(' '));
    this.strategy = structuredClone(s);
    this.addDecision(
      'scan',
      'Strategy updated',
      `Pool cap ${s.maxAllocPct}%, min cap ${fmtMcap(s.minMcapM)}, trend exit −${Math.abs(s.trendExitPct)}%, loss stop ${s.dailyStopPct}%.`,
      false,
    );
    return this.getStrategy();
  }

  pause(): VaultOverview {
    if (!this.vault.paused) {
      this.vault.paused = true;
      if (this.stepTimer) clearTimeout(this.stepTimer);
      this.cycle = { ...this.cycle, step: -1, paused: true, decision: undefined };
      this.emitCycle();
      this.emitVault();
    }
    return this.getOverview();
  }

  resume(): VaultOverview {
    if (this.vault.paused) {
      this.vault.paused = false;
      this.emitVault();
      this.runCycle();
    }
    return this.getOverview();
  }

  setMode(mode: VaultMode): VaultOverview {
    if (mode === 'live' && !this.opts.liveTradingEnabled)
      throw new MockError('live_disabled', "Live mode isn't available yet. Paper mode stays on.", 403);
    if (mode !== 'live' && mode !== 'paper') throw new MockError('invalid_mode', 'Mode must be paper or live.');
    this.vault.mode = mode;
    this.emitVault();
    return this.getOverview();
  }

  deposit(symbol: string, amt: number): VaultOverview {
    const asset = this.assets.find((a) => a.symbol === symbol);
    if (!asset) throw new MockError('unknown_token', 'That token can’t be deposited.');
    if (!Number.isFinite(amt) || amt <= 0) throw new MockError('invalid_amount', 'Enter an amount.');
    if (amt > asset.balance) throw new MockError('insufficient_balance', `Not enough ${symbol}`);
    const v = amt * asset.priceUsd;
    asset.balance -= amt;
    this.vault.value += v;
    this.vault.openValue += v;
    this.addDecision(
      'deploy',
      `Deposited ${amount(amt)} ${symbol}`,
      `Added ${usd(v)} to the vault. The agent places it on the next cycle.`,
      true,
    );
    this.emitVault();
    return this.getOverview();
  }

  claim(positionId: string): { amount: number } {
    const p = this.findPosition(positionId);
    const view = this.positionView(p);
    this.addDecision('compound', `Claimed fees from ${view.pair}`, 'Manual claim. Sent to your vault balance.', true, true, p.def.poolId);
    return { amount: view.fees };
  }

  close(positionId: string): { ok: true } {
    const p = this.findPosition(positionId);
    // The mock keeps the position open so the demo stays populated; the real executor removes it.
    this.addDecision('exit', `Closed ${this.positionView(p).pair}`, 'Manual close. Funds returned to your vault.', true, true, p.def.poolId);
    return { ok: true };
  }

  // ---------- simulation ----------

  private findPosition(id: string): LivePosition {
    const p = this.positions.find((x) => x.def.id === id);
    if (!p) throw new MockError('not_found', 'No position with that id.', 404);
    return p;
  }

  private positionView({ def, sim }: LivePosition): PositionView {
    const pool = POOLS.find((x) => x.id === def.poolId)!;
    return {
      id: def.id,
      poolId: def.poolId,
      pair: pairName(pool),
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      shape: def.shape,
      value: def.value,
      fees: def.fees + sim.fees,
      il: def.il,
      netVsHold: def.net + sim.net,
      rebalances: def.rebalances + sim.reb,
      inRange: sim.inR,
      chart: sim.chart(),
    };
  }

  private tick() {
    const r = this.opts.random;
    this.positions.forEach((p, i) => {
      const { event, marker } = p.sim.tick(!this.vault.paused);
      const view = this.positionView(p);
      this.emit({
        type: 'tick',
        tick: {
          positionId: p.def.id,
          price: p.sim.price,
          lo: p.sim.lo,
          hi: p.sim.hi,
          inRange: view.inRange,
          event,
          marker,
          fees: view.fees,
          netVsHold: view.netVsHold,
          rebalances: view.rebalances,
        },
      });
      if (event !== 'rebalance') return;
      if (i === 0)
        this.addDecision(
          'rebalance',
          `Rebalanced ${view.pair}`,
          `Price left range at ${p.sim.price.toFixed(6)} SOL. Expected fees beat the move cost 31x.`,
          true,
          true,
          p.def.poolId,
        );
      else if (r() < 0.5)
        this.addDecision('rebalance', `Rebalanced ${view.pair}`, 'Price left range. Re-centered because fees cover the cost.', true, true, p.def.poolId);
    });
    if (!this.vault.paused) {
      this.vault.value += (r() - 0.4) * 6;
      this.vault.fees30d += r() * 0.9;
      this.vault.net += (r() - 0.47) * 0.01;
      this.emitVault();
    }
  }

  private decide(): CycleDecision & { feed?: boolean } {
    const r = this.opts.random;
    const main = this.positions[0];
    const pair = pairName(POOLS.find((x) => x.id === main.def.poolId)!);
    if (!main.sim.inR)
      return {
        short: `Rebalance ${pair}`,
        text: `${pair} is out of range. Expected fees over 6 hours are $9.80 against a $0.31 move cost. Rebalancing.`,
        tx: true,
      };
    if (r() < 0.25)
      return {
        short: 'Compound fees',
        text: `Claimed $${amount(18 + r() * 24)} in fees. Gas is under 1% of the amount, so adding it back to ${pair}.`,
        tx: true,
        feed: true,
      };
    return {
      short: 'Hold all positions',
      text: 'All positions are in range and trends are healthy. Moving anything now would cost more than it earns.',
      tx: false,
    };
  }

  private runCycle() {
    if (this.stepTimer) clearTimeout(this.stepTimer);
    if (this.vault.paused) return;
    this.vault.cycle++;
    this.cycleStartedAt = this.opts.now();
    let decision: ReturnType<MockEngine['decide']> | undefined;
    const steps = STEPS.map((s) => ({ ...s }));
    this.cycle = { cycle: this.vault.cycle, step: 0, paused: false, intervalMs: this.opts.cycleMs, elapsedMs: 0, steps };
    this.emitCycle();
    this.emitVault();
    const advance = () => {
      if (this.vault.paused) return;
      const step = this.cycle.step + 1;
      if (step === 3) {
        const inRange = this.positions.filter((p) => p.sim.inR).length;
        steps[2].done = `${inRange} of ${this.positions.length} positions in range`;
      }
      if (step === 4) {
        decision = this.decide();
        steps[3].done = decision.short;
      }
      if (step === 5) steps[4].done = decision?.tx ? 'Confirmed in 1 block' : 'No transaction needed';
      const { feed: _feed, ...pub } = decision ?? ({} as CycleDecision & { feed?: boolean });
      this.cycle = { ...this.cycle, step, steps: steps.map((s) => ({ ...s })), decision: decision ? pub : undefined };
      this.emitCycle();
      if (step < 5) {
        this.stepTimer = setTimeout(advance, this.opts.stepMs);
        return;
      }
      if (decision?.feed) {
        this.addDecision('compound', 'Compounded fees', decision.text, true, true, this.positions[0].def.poolId);
        this.vault.fees30d += 20;
      } else if (this.opts.random() < 0.2) {
        this.addDecision('scan', 'Scanned 214 pools', '38 passed filters. No changes to the shortlist.', false);
      }
    };
    this.stepTimer = setTimeout(advance, this.opts.stepMs);
  }

  private emitCycle() {
    this.emit({ type: 'cycle', cycle: this.getCycle() });
  }

  private vaultLive(): VaultLive {
    return {
      value: this.vault.value,
      openValue: this.vault.openValue,
      fees30d: this.vault.fees30d,
      netVsHold30d: this.vault.net,
      status: this.vault.paused ? 'paused' : 'running',
      mode: this.vault.mode,
      cycle: this.vault.cycle,
    };
  }

  private emitVault() {
    this.emit({ type: 'vault', vault: this.vaultLive() });
  }

  private addDecision(type: DecisionType, title: string, reason: string, tx: boolean, emit = true, poolId?: string) {
    const id = ++this.seq;
    const d: Decision = {
      id: `d-${id}`,
      vaultId: this.vaultId,
      poolId,
      ts: this.opts.now(),
      type,
      title,
      reason,
      // Paper mode: fills are simulated, so the signature is a placeholder, not an on-chain tx.
      txSig: tx ? `sim-${id}` : undefined,
    };
    this.decisions.unshift(d);
    if (this.decisions.length > 60) this.decisions.pop();
    if (emit) this.emit({ type: 'decision', decision: d });
  }
}

// ---------- landing-page demo stream ----------

const THOUGHTS = {
  hold: [
    (p: string) => `Price ${p} is inside the range. Volume per dollar of liquidity is 1.9x, so fees keep flowing. Holding.`,
    () => `7-day trend is still positive and volatility is normal. No reason to move liquidity.`,
    () => `Checked rebalance cost against the next 6 hours of fees. Staying put is cheaper.`,
  ],
  out: (p: string) => `Price ${p} just left the range. Waiting one more tick, since price often snaps back.`,
  wait: () => `Still outside the range. Expected fees over 6 hours beat the move cost, so I'm preparing a rebalance.`,
  rebalance: (p: string) => `Re-centered liquidity around ${p}. Cost was about $0.31, earned back in under 40 minutes.`,
  back: () => `Price came back into range on its own. Saved the cost of a rebalance.`,
};

export const DEMO_IDS = Object.keys(DEMO_PAIRS);

/**
 * Read-only demo stream for the landing page window: one simulated position
 * with the agent's reasoning. Returns a function that stops the stream.
 */
export function startDemo(
  id: string,
  onEvent: (e: DemoEvent) => void,
  opts: { tickMs?: number; now?: () => number } = {},
): () => void {
  const cfg = DEMO_PAIRS[id];
  if (!cfg) throw new MockError('not_found', 'Unknown demo pair.', 404);
  const now = opts.now ?? Date.now;
  const sim = new PriceSim(cfg);
  sim.fees = cfg.feeRate * 14;
  sim.net = 0.42;
  sim.ticks = 20;
  sim.inTicks = 19;
  let lastThought = now();
  const stats = () => ({
    fees: sim.fees,
    netVsHold: sim.net,
    rebalances: sim.reb,
    timeInRange: Math.round((sim.inTicks / Math.max(1, sim.ticks)) * 100),
    inRange: sim.inR,
  });
  const shape = cfg.shape === 'bidask' ? 'bid-ask' : cfg.shape;
  onEvent({
    type: 'demo:snapshot',
    chart: sim.chart(),
    stats: stats(),
    mode: 'Holding position',
    thought: THOUGHTS.hold[0](sim.price.toFixed(cfg.decimals)),
    log: [['Deployed', `${cfg.name}, ${shape}`]],
  });
  const timer = setInterval(() => {
    const { event, marker } = sim.tick();
    const ps = sim.price.toFixed(cfg.decimals);
    let thought: string | undefined;
    let mode = 'Holding position';
    let log: [string, string] | undefined;
    if (event === 'hold') {
      if (now() - lastThought > 7000) {
        lastThought = now();
        thought = THOUGHTS.hold[((sim.ticks / 5) | 0) % 3](ps);
      }
    } else {
      lastThought = now();
      thought = THOUGHTS[event](ps);
      mode = event === 'rebalance' ? 'Rebalanced' : event === 'back' ? 'Back in range' : 'Evaluating a rebalance';
      if (event === 'rebalance') log = ['Rebalanced', `around ${ps}`];
      if (event === 'back') log = ['Skipped rebalance', 'price returned'];
    }
    onEvent({ type: 'demo:tick', price: sim.price, lo: sim.lo, hi: sim.hi, marker, stats: stats(), mode, thought, log });
  }, opts.tickMs ?? 1400);
  return () => clearInterval(timer);
}
