// The token radar's model (radar-2): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// every pre-token protocol below the floor that passes the watchlist's own eligibility rule: not a
// wrapped, staked or bridged product of a token that already trades, not an exchange, not a versioned
// pool. A protocol is pre-token when its index entry records no token (no market cap, no CoinGecko
// id, no symbol); the live-token protocols are kept apart and shown with the market's own values,
// never mixed into the ranked board.
//
// Implied value is priced off the market itself, not off a fixed multiple. For each category, the
// model takes the median market-cap-to-TVL ratio of the snapshot's own live-token protocols in that
// category (at least 3 peers; fewer peers fall back to the global median across all live protocols),
// clamped to a sane band. A pre-token protocol is then worth what its already-trading peers are
// worth per dollar of TVL:
//
//   ratio      = median(mcap_usd / tvl_usd) over live peers in the category, clamped to [0.05, 1.0]
//   growth     = clamp(change_7d, -50, 100) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   chainMult  = 1 + 0.02 x min(max(chains - 1, 0), 5)
//   implied    = max(1, round(tvl_usd x ratio x growthMult x maturity x chainMult))
//
// No protocol name is ever special-cased: the same functions score every row, and every constant is
// stated in the dashboard. The ratios are recomputed from the snapshot on every run, so the board
// follows the market the snapshot records rather than a hand-kept list.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  ratio_floor: number;
  ratio_cap: number;
  min_peers: number;
  chain_step: number;
  chain_max_bonus: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  ratio_floor: 0.05,
  ratio_cap: 1.0,
  min_peers: 3,
  chain_step: 0.02,
  chain_max_bonus: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's calibrated ratio: the median live mcap/TVL and how many peers set it. */
export interface CategoryRatio {
  ratio: number;
  peers: number;
}

/** The calibration: one ratio per category, plus the global fallback. */
export interface Calibration {
  by_category: Record<string, CategoryRatio>;
  global: CategoryRatio;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    ratio: number;
    ratio_peers: number;
    ratio_source: 'category' | 'global';
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan regenerated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  ratio: number;
  ratio_peers: number;
  ratio_source: 'category' | 'global';
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * Calibrate the value ratios from the snapshot's own live-token protocols: for each category, the
 * median market-cap-to-TVL ratio of its live protocols, clamped to the model's band. Categories with
 * fewer than `min_peers` live protocols get no ratio of their own and fall back to the global median.
 */
export function calibrateRatios(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const clamp = (r: number): number => Math.min(model.ratio_cap, Math.max(model.ratio_floor, r));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const by_category: Record<string, CategoryRatio> = {};
  for (const [key, list] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < model.min_peers) continue;
    by_category[key] = { ratio: round4(clamp(median(list)!)), peers: list.length };
  }
  const globalMedian = median(live.map((p) => p.mcap_usd! / p.tvl_usd)) ?? 0.2;
  return { by_category, global: { ratio: round4(clamp(globalMedian)), peers: live.length } };
}

/** The ratio one protocol is priced at, and where it came from. */
export function ratioFor(p: SnapshotProtocol, calibration: Calibration): { ratio: number; peers: number; source: 'category' | 'global' } {
  const own = calibration.by_category[p.category ?? 'Other'];
  if (own !== undefined) return { ratio: own.ratio, peers: own.peers, source: 'category' };
  return { ratio: calibration.global.ratio, peers: calibration.global.peers, source: 'global' };
}

/** The multipliers and the implied value one protocol gets under `model` and `calibration`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
  model: ModelConstants = MODEL,
): {
  implied: number;
  ratio: number;
  ratioPeers: number;
  ratioSource: 'category' | 'global';
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const { ratio, peers, source } = ratioFor(protocol, calibration);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainMult = 1 + model.chain_step * Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_bonus);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * ratio * growthMult * maturityMult * chainMult));
  return { implied, ratio, ratioPeers: peers, ratioSource: source, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that mark a wrapped, staked or bridged product rather than a protocol of its own. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names: a protocol whose name begins with one is an exchange's product, not a launch. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a name carries a whole word, in any case. */
function hasWord(name: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(name);
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol below the watchlist floor belongs on the early radar: pre-token, and passing
 * the watchlist's own eligibility rule (not a wrapped, staked or bridged product, not an exchange,
 * not a versioned pool). The watchlist's slugs are always ranked; this rule decides the rest.
 */
export function isEarlyEligible(p: SnapshotProtocol, floorUsd: number): boolean {
  if (!isPreToken(p)) return false;
  if (p.tvl_usd >= floorUsd) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (hasWord(p.name, 'wrapped') || hasWord(p.name, 'staked') || hasWord(p.name, 'staking')) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrateRatios(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every eligible pre-token protocol below the watchlist floor, not just the
  // largest few — the small ones are the launches the radar exists to find early.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isEarlyEligible(p, snapshot.floor_usd)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      ratio: s.ratio,
      ratio_peers: s.ratioPeers,
      ratio_source: s.ratioSource,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan regenerated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    on_watchlist: row.on_watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    ratio: row.model.ratio,
    ratio_peers: row.model.ratio_peers,
    ratio_source: row.model.ratio_source,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrateRatios(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board has ${board.length} rows, fewer than the 100 the gate needs`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  const index = bySlug(snapshot.protocols);
  for (const r of board) {
    if (!index.has(r.slug)) return `${r.slug} is not a protocol the snapshot lists`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The second chain a protocol names, or null when it runs on one chain only. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much one transaction costs on a chain, in whole dollars of gas, as the page states it. */
export function gasUsd(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return '$8';
  if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'near') return 'under $0.05';
  if (c === 'binance' || c === 'bsc') return '$0.20';
  if (c === 'avalanche') return '$0.30';
  if (
    c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'zksync era' ||
    c === 'linea' || c === 'scroll' || c === 'mantle' || c === 'blast' || c === 'sonic' ||
    c === 'celo' || c === 'mode' || c === 'ink' || c === 'soneium' || c === 'unichain'
  ) {
    return '$0.50';
  }
  return '$1';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 75;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 90) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('liquid restaking') || c.includes('restak')) return `Restake $${capital} of liquid staking tokens through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('liquid staking') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('leveraged farm')) return `Open a $${capital} leveraged liquidity position in ${name}'s main farm on ${chain} and keep it open.`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s main yield pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one position in an active market.`;
  if (c.includes('basis trading')) return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the vault shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${name} and use its main apps: a swap and a deposit.`;
  if (c.includes('payment')) return `Fund $${capital} on ${name} and pay one real invoice or transfer through it.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name} on ${chain} and cast one governance vote.`;
  if (c.includes('nft')) return `Buy or list one NFT through ${name} on ${chain} and keep the position.`;
  if (c.includes('launchpad')) return `Commit $${capital} to an active launch on ${name} and complete its checks.`;
  if (c.includes('option')) return `Deposit $${capital} of USDC on ${name} and open one small covered option.`;
  if (c.includes('privacy')) return `Deposit $${capital} into ${name}'s shielded pool on ${chain} and make one private transfer.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  if (c.includes('liquidity manager')) return `Deposit $${capital} into ${name}'s managed liquidity vault on ${chain} and keep the shares.`;
  if (c.includes('token locker')) return `Lock $${capital} of tokens through ${name} on ${chain} for the shortest term it offers.`;
  if (c.includes('ai')) return `Deposit $${capital} into ${name} on ${chain} and run one task through its agent product.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second, repeatable action: the weekly activity a snapshot counts. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Swap $25 through ${name}'s router on ${chain} once a week, so the wallet shows trading volume as well as liquidity.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against the supply once, then repay it the same week, so the wallet shows both sides of the market.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis trading')) return `Claim or compound the vault's rewards once a week instead of letting them sit unclaimed.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Open and close one small hedged trade a week, keeping the margin deposit in place between trades.`;
  if (c.includes('bridge')) return `Bridge a second, smaller amount a week later, so the wallet shows repeat use rather than one transfer.`;
  if (c.includes('staking') || c.includes('restak')) return `Check the staking rewards each week and restake them, so the position compounds.`;
  if (c.includes('rwa') || c.includes('stable')) return `Top the position up by $25 once, so the wallet shows a second deposit after the first.`;
  if (c.includes('chain')) return `Use one more app on ${name} each week, such as a second swap or a deposit into another pool.`;
  if (c.includes('governance')) return `Vote on one more proposal when the next one opens, and keep the deposit in place.`;
  if (c.includes('prediction')) return `Place one more small position in a different market the following week.`;
  return `Make one more qualifying action each week, such as a deposit, a swap or a vote, so the wallet shows steady activity.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. The dashboard's page regenerates the same plan from the same fields.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const steps: FarmStep[] = [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm with, and store its seed phrase offline, never in a chat or a screenshot.`,
      cost: `about ${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: `about ${gas} of gas a week`,
      time: '10 minutes a week',
    },
  ];
  if (second !== null) {
    steps.push({
      text: `Repeat the position on ${second} with half the capital, so the wallet is active on two chains the protocol runs on.`,
      cost: `$${Math.round(capital / 2)} more capital and about ${gasUsd(second)} of gas`,
      time: '15 minutes',
    });
  } else {
    steps.push({
      text: `Open a second position in another pool of ${p.name} on ${chain}, so the wallet shows more than one interaction with the protocol.`,
      cost: `$${Math.round(capital / 2)} more capital and about ${gas} of gas`,
      time: '15 minutes',
    });
  }
  steps.push(
    {
      text: `Open ${p.name}'s points or rewards page each week and finish the tasks it lists, such as a quest, a referral or a social action.`,
      cost: `no fee to check; tasks cost about ${gas} of gas each`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, check the protocol's own points or rewards page and claim only from the link it publishes; never pay a fee to claim.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps;
}
