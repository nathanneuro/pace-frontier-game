// Pace simulation. Mechanics and constants reproduce Paradigm's Pace
// (paradigm.xyz/research/pace); see docs/original_mechanics.md.
// Our change: the safety frontier is hidden. Players see a danger band of
// half-width `halfWidth` whose center is offset from the true frontier by a
// hidden bias drawn uniformly from [-halfWidth, halfWidth].

export const PROFIT = Object.freeze({
  baseProfit: 5e9,
  capabilityUpside: 1e10,
  capabilityGrowth: 0.025,
  leadBonus: 3e9,
  transitionWidth: 2,
  lagDiscount: 0.4,
  maximumLoss: 8e9,
  competitionReference: 22,
  competitionScale: 4,
  closeRaceWidth: 2,
});

export const CLOCK = Object.freeze({
  startUtc: Date.UTC(2026, 6, 28),
  daysPerSecond: 7,
  yearsPerSecond: 7 / 365,
});

export const SIM = Object.freeze({
  dt: 1 / 60,
  duration: 90,
  deploymentWeeks: 2,
  acceleration: 0.62,
  deceleration: 0.62,
  safetySpeed: 0.792,
  startingSafety: 12,
  safetyFlatUntil: 18,
});

const SAFETY_DRIFT = Object.freeze({
  minimumSpeed: 0.264,
  maximumSpeed: 1.584,
  speedPower: 1.5,
  minimumInterval: 2,
  maximumInterval: 6,
  responseTime: 1,
});

const PLATEAU = Object.freeze({
  minimumRise: 12,
  maximumRise: 20,
  minimumFlat: 2,
  maximumFlat: 4,
  transition: 1,
  risingSpeedScale: 1.2,
});

const SPEED = Object.freeze({
  initialSpeed: 1.5,
  earlyRsiShare: 0.08,
  earlyRsiScale: 12,
  rsiThreshold: 24,
  rsiScale: 12,
  maximumSpeed: 3.24,
});

const HAZARD = Object.freeze({
  maxRate: 0.24,
  capabilityScale: 12,
  gapScale: Math.sqrt(75),
  gapPower: 2,
});

export const UNCERTAINTY = Object.freeze({
  halfWidth: 3,
  gridPoints: 41,
  // Where in the band the bot aims: 0 = lower edge, 1 = upper edge.
  botBandPosition: 0.25,
});

export const SECONDS_PER_MONTH = 1 / (12 * CLOCK.yearsPerSecond);
export const DEPLOY_LAG = (SIM.deploymentWeeks * 7) / CLOCK.daysPerSecond;
const EPS = 1e-8;

export function profitRate(own, rival) {
  const P = PROFIT;
  const base = P.baseProfit + P.capabilityUpside * Math.log1p(P.capabilityGrowth * Math.max(0, own));
  const lead = own - rival;
  if (lead >= 0) return base + P.leadBonus * Math.log1p(lead / P.transitionWidth);
  const lag = -lead;
  const discounted = base / (1 + P.lagDiscount * Math.log1p(lag / P.transitionWidth));
  const x = Math.log(lag) + (rival - P.competitionReference) / P.competitionScale;
  const softplus = Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)));
  const squeezed = (discounted + P.maximumLoss) / (1 + softplus) - P.maximumLoss;
  const u = Math.min(1, lag / P.closeRaceWidth);
  return discounted + (squeezed - discounted) * u * u * (3 - 2 * u);
}

export function hazardRate(capability, safety) {
  const c = Math.max(0, capability);
  const gap = Math.max(0, c - safety);
  return HAZARD.maxRate / (1 + (HAZARD.capabilityScale / c) ** 2) / (1 + (HAZARD.gapScale / gap) ** HAZARD.gapPower);
}

export function monthlyRisk(rate) {
  return -Math.expm1(-rate * SECONDS_PER_MONTH);
}

function random(state) {
  let t = (state.random = (state.random + 1831565813) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const uniform = (state, lo, hi) => lo + random(state) * (hi - lo);

function plateauProgress(phase, elapsed, duration) {
  if (phase === 'rising') return elapsed;
  if (phase === 'flat') return 0;
  const r = elapsed / duration;
  const eased = duration * (r ** 3 - r ** 4 / 2);
  return phase === 'slowing' ? elapsed - eased : eased;
}

// Mean fraction of full frontier speed over the next `dt`, cycling rising -> slowing -> flat -> resuming.
function advancePlateau(p, dt) {
  let left = dt;
  let moved = 0;
  while (left > 1e-10) {
    const step = Math.min(left, p.duration - p.elapsed);
    moved += plateauProgress(p.phase, p.elapsed + step, p.duration) - plateauProgress(p.phase, p.elapsed, p.duration);
    p.elapsed += step;
    left -= step;
    if (p.elapsed + 1e-10 < p.duration) continue;
    p.elapsed = 0;
    if (p.phase === 'rising') [p.phase, p.duration] = ['slowing', PLATEAU.transition];
    else if (p.phase === 'slowing') [p.phase, p.duration] = ['flat', uniform(p, PLATEAU.minimumFlat, PLATEAU.maximumFlat)];
    else if (p.phase === 'flat') [p.phase, p.duration] = ['resuming', PLATEAU.transition];
    else [p.phase, p.duration] = ['rising', uniform(p, PLATEAU.minimumRise, PLATEAU.maximumRise)];
  }
  return Math.max(0, Math.min(1, moved / dt));
}

function advanceSafety(g, dt) {
  if (g.t <= SIM.safetyFlatUntil + EPS) return;
  const span = Math.max(0, g.t - Math.max(g.t - dt, SIM.safetyFlatUntil));
  if (!span) return;
  const m = g.safetyMotion;
  if (g.t >= m.nextChange) {
    m.target = SAFETY_DRIFT.minimumSpeed + random(m) ** SAFETY_DRIFT.speedPower * (SAFETY_DRIFT.maximumSpeed - SAFETY_DRIFT.minimumSpeed);
    m.nextChange = g.t + SAFETY_DRIFT.minimumInterval + random(m) * (SAFETY_DRIFT.maximumInterval - SAFETY_DRIFT.minimumInterval);
  }
  const blend = -Math.expm1(-span / SAFETY_DRIFT.responseTime);
  const distance = m.target * span + (m.speed - m.target) * SAFETY_DRIFT.responseTime * blend;
  const scale = m.plateau ? PLATEAU.risingSpeedScale * advancePlateau(m.plateau, span) : 1;
  g.safety += distance * scale;
  m.speed += (m.target - m.speed) * blend;
}

// Top research speed rises with capability (recursive self-improvement past rsiThreshold).
function topSpeed(lab) {
  const x = Math.max(0, lab.position);
  const early = -Math.expm1(-x / SPEED.earlyRsiScale);
  const r = Math.max(0, x - SPEED.rsiThreshold) / SPEED.rsiScale;
  const late = -Math.expm1(-(r ** 2));
  const share = SPEED.earlyRsiShare * early + (1 - SPEED.earlyRsiShare) * late;
  return SPEED.initialSpeed + (SPEED.maximumSpeed - SPEED.initialSpeed) * share;
}

export function stoppingDistance(lab) {
  return lab.speed ** 2 / (2 * SIM.deceleration * topSpeed(lab));
}

function moveLab(lab, dt) {
  const v0 = lab.speed;
  const top = topSpeed(lab);
  if (lab.held) {
    lab.speed = Math.min(top, v0 + SIM.acceleration * top * dt);
    lab.position += ((v0 + lab.speed) / 2) * dt;
    return;
  }
  const decel = SIM.deceleration * top;
  const moving = Math.min(dt, v0 / decel);
  lab.speed = Math.max(0, v0 - decel * dt);
  lab.position += ((v0 + lab.speed) / 2) * moving;
}

export function isLive(g) {
  return g.phase === 'running' || g.phase === 'settling';
}

export const frontierCapability = (g) => Math.max(0, ...g.labs.map((l) => l.deployed));
export const bandCenter = (g) => g.safety + g.bias;

function gridRates(g) {
  const c = frontierCapability(g);
  const center = bandCenter(g);
  return g.biasGrid.map((b) => hazardRate(c, center - b));
}

export function createGame(seed = 1, { halfWidth = UNCERTAINTY.halfWidth, gridPoints = UNCERTAINTY.gridPoints, plateaus = true } = {}) {
  let n = seed >>> 0;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  const u = ((n >>> 0) + 1) / 4294967297;
  const biasRng = { random: (seed ^ 0x27d4eb2f) >>> 0 };
  const g = {
    t: 0,
    phase: 'running',
    safety: SIM.startingSafety,
    safetyMotion: {
      random: (seed ^ 2654435769) >>> 0,
      speed: SIM.safetySpeed,
      target: SIM.safetySpeed,
      nextChange: SIM.safetyFlatUntil,
    },
    hazard: 0,
    threshold: -Math.log(u),
    halfWidth,
    bias: halfWidth * (2 * random(biasRng) - 1),
    // Midpoints of a uniform prior over the hidden bias; hazard accumulated under each hypothesis.
    biasGrid: Array.from({ length: gridPoints }, (_, k) => halfWidth * (-1 + (2 * k + 1) / gridPoints)),
    gridHazard: new Array(gridPoints).fill(0),
    reason: null,
    scores: null,
    labs: [0, 1].map(() => ({ position: 0, deployed: 0, deployments: [], speed: 0, held: false, cash: 0, profit: PROFIT.baseProfit })),
    history: [],
  };
  if (plateaus) {
    const p = { random: (seed ^ 2246822507) >>> 0, phase: 'rising', elapsed: 0, duration: 0 };
    p.duration = uniform(p, PLATEAU.minimumRise, PLATEAU.maximumRise);
    g.safetyMotion.plateau = p;
  }
  record(g);
  return g;
}

function record(g) {
  g.history.push({ t: g.t, safety: g.safety, center: bandCenter(g), deployed: g.labs.map((l) => l.deployed) });
}

function finish(g, reason) {
  g.phase = reason === 'catastrophe' ? 'crashed' : 'finished';
  g.reason = reason;
  for (const lab of g.labs) {
    if (reason === 'catastrophe') [lab.cash, lab.profit] = [0, 0];
    [lab.held, lab.speed] = [false, 0];
  }
  g.scores = g.labs.map((l) => l.cash);
}

export function step(g) {
  const dt = SIM.dt;
  const rate0 = hazardRate(frontierCapability(g), g.safety);
  const grid0 = gridRates(g);
  const profit0 = g.labs.map((lab, i) => profitRate(lab.deployed, g.labs[1 - i].deployed));
  g.t += dt;
  for (const lab of g.labs) {
    const before = lab.position;
    moveLab(lab, dt);
    if (lab.position > before) lab.deployments.push({ at: g.t + DEPLOY_LAG, position: lab.position });
    while (lab.deployments.length && lab.deployments[0].at <= g.t + EPS) lab.deployed = lab.deployments.shift().position;
  }
  if (g.t + EPS >= SIM.duration && g.phase === 'running') {
    g.phase = 'settling';
    for (const lab of g.labs) [lab.held, lab.speed] = [false, 0];
  }
  advanceSafety(g, dt);
  g.hazard += ((rate0 + hazardRate(frontierCapability(g), g.safety)) / 2) * dt;
  gridRates(g).forEach((r, k) => (g.gridHazard[k] += ((grid0[k] + r) / 2) * dt));
  const years = dt * CLOCK.yearsPerSecond;
  g.labs.forEach((lab, i) => {
    lab.profit = profitRate(lab.deployed, g.labs[1 - i].deployed);
    lab.cash = Math.max(0, lab.cash + ((profit0[i] + lab.profit) / 2) * years);
  });
  if (g.hazard > 0 && g.hazard >= g.threshold) finish(g, 'catastrophe');
  else if (g.t + EPS >= SIM.duration && g.labs.every((l) => !l.deployments.length)) finish(g, 'completed');
  if (Math.floor((g.t + EPS) * 10) > Math.floor((g.t - dt + EPS) * 10) || !isLive(g)) record(g);
}

// Posterior over the hidden bias given survival so far: P(survive | b) = exp(-H_b), uniform prior.
export function biasPosterior(g) {
  const minH = Math.min(...g.gridHazard);
  const w = g.gridHazard.map((h) => Math.exp(minH - h));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

// Catastrophe risk over the next month as the player can compute it: averaged over the posterior.
export function expectedMonthlyRisk(g) {
  const post = biasPosterior(g);
  return gridRates(g).reduce((sum, r, k) => sum + post[k] * monthlyRisk(r), 0);
}

// Practice bot. Same rule as the original, except it aims at a point inside the danger band
// instead of the (now hidden) true frontier. Accelerates while its stopping point stays below
// target; if behind, targets 1.5 past the rival's deployed model.
export function botWantsToAccelerate(g, idx = 1) {
  if (g.phase !== 'running') return false;
  const me = g.labs[idx];
  const rival = g.labs[1 - idx];
  const aim = bandCenter(g) + g.halfWidth * (2 * UNCERTAINTY.botBandPosition - 1);
  const target = Math.max(aim, me.deployed < rival.deployed ? rival.deployed + 1.5 : 0);
  return me.position + stoppingDistance(me) < target - (me.held ? 0 : 0.3);
}

// Advance one tick: player input on lab 0, bot on lab 1.
export function tick(g, playerHeld) {
  if (!isLive(g)) return;
  if (g.phase === 'running') {
    g.labs[0].held = playerHeld;
    g.labs[1].held = botWantsToAccelerate(g, 1);
  }
  step(g);
}

export function cumulativeRisk(g) {
  return -Math.expm1(-Math.max(0, g.hazard));
}

export function monthsRemaining(t) {
  return Math.ceil(Math.max(0, SIM.duration - t) * CLOCK.yearsPerSecond * 12 - 1e-9);
}

export function gameDate(t) {
  return new Date(CLOCK.startUtc + Math.floor(Math.max(0, t) * CLOCK.daysPerSecond + 1e-8) * 864e5);
}
