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
  // Where in its danger zone the bot aims: 0 = lower edge, 1 = upper edge.
  botBandPosition: 0.25,
});

// Advanced mode. Each lab splits research funding between capability and safety, and holds three
// tiers of capability: latent (research) >= internal (run inside the lab; drives self-improvement)
// >= external (sold to customers; earns profit; the only tier the rival can see).
export const ADVANCED = Object.freeze({
  // Catastrophe-risk weight of internal-only and latent-only capability, relative to external (1).
  internalRiskWeight: 0.6,
  latentRiskWeight: 0.25,
  // Frontier speed added by one lab putting all research funding into safety. Shared by both labs.
  safetyResearchSpeed: 0.5,
  // Each lab's estimate of the frontier is truth + its own hidden offset b. b mean-reverts
  // (Ornstein-Uhlenbeck) and is kicked up by false breakthroughs. Real breakthroughs raise the
  // true frontier and every lab's estimate. A lab sees the jump but not whether it was real.
  biasReversion: 0.1,
  realBreakthroughRate: 1 / 16,
  falseBreakthroughRate: 1 / 16,
  breakthroughMin: 1,
  breakthroughMax: 3,
  // Particles in the player's belief over its own offset.
  particles: 256,
  // Bot keeps this much internal and latent capability above what it deploys externally.
  botInternalHeadroom: 1.5,
  botLatentHeadroom: 3,
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
// Classic: driven by latent research position. Advanced: driven by internally deployed capability.
function topSpeed(g, lab) {
  const x = Math.max(0, g.advanced ? lab.internal : lab.position);
  const early = -Math.expm1(-x / SPEED.earlyRsiScale);
  const r = Math.max(0, x - SPEED.rsiThreshold) / SPEED.rsiScale;
  const late = -Math.expm1(-(r ** 2));
  const share = SPEED.earlyRsiShare * early + (1 - SPEED.earlyRsiShare) * late;
  return SPEED.initialSpeed + (SPEED.maximumSpeed - SPEED.initialSpeed) * share;
}

export function stoppingDistance(g, lab) {
  return lab.speed ** 2 / (2 * SIM.deceleration * topSpeed(g, lab));
}

// Classic: accelerate while held, else brake. Advanced: speed approaches research * top speed
// at the same acceleration, where research is the capability share of funding.
function moveLab(g, lab, dt) {
  const v0 = lab.speed;
  const top = topSpeed(g, lab);
  if (g.advanced) {
    const target = lab.research * top;
    const change = SIM.acceleration * top * dt;
    lab.speed = v0 < target ? Math.min(target, v0 + change) : Math.max(target, v0 - change);
    lab.position += ((v0 + lab.speed) / 2) * dt;
    return;
  }
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

// Each lab's estimated frontier (center of its danger zone).
export const bandCenter = (g, i = 0) => g.safety + g.labs[i].bias;

// Capability that generates catastrophe risk for one lab: external counts fully, internal-only and
// latent-only capability at their weights. In classic mode this is just deployed capability.
const labRisk = (g, l) => l.deployed
  + g.internalRiskWeight * (l.internal - l.deployed)
  + g.latentRiskWeight * Math.max(0, l.position - l.internal);

export const riskCapability = (g) => Math.max(0, ...g.labs.map((l) => labRisk(g, l)));

// What the player (lab 0) can compute: its own risk plus the rival's external deployment only.
// A lower bound on riskCapability whenever the rival holds undeployed capability.
export const visibleRiskCapability = (g) => Math.max(0, labRisk(g, g.labs[0]), g.labs[1].deployed);

function normal(rng) {
  return Math.sqrt(-2 * Math.log(1 - random(rng))) * Math.cos(2 * Math.PI * random(rng));
}

// Offset process for advanced mode, scaled so the offset's stationary spread is halfWidth / 1.5
// (the zone is roughly a 1.5-sigma band) and its stationary mean is zero: false breakthroughs push
// b up on average, so between them b drifts down (real progress the estimate hasn't noticed).
function offsetProcess(halfWidth) {
  const A = ADVANCED;
  const falseRate = halfWidth > 0 ? A.falseBreakthroughRate : 0;
  const meanJump = (A.breakthroughMin + A.breakthroughMax) / 2;
  const meanSqJump = (A.breakthroughMin ** 2 + A.breakthroughMin * A.breakthroughMax + A.breakthroughMax ** 2) / 3;
  const jumpVariance = (falseRate * meanSqJump) / (2 * A.biasReversion);
  const spread = halfWidth / 1.5;
  return {
    falseRate,
    mean: (-falseRate * meanJump) / A.biasReversion,
    diffusion: Math.sqrt(Math.max(0, spread ** 2 - jumpVariance)),
    spread,
    realGivenJump: A.realBreakthroughRate / (A.realBreakthroughRate + falseRate),
  };
}

function driftOffset(b, proc, dt, rng) {
  const theta = ADVANCED.biasReversion;
  return b + theta * (proc.mean - b) * dt + proc.diffusion * Math.sqrt(2 * theta * dt) * normal(rng);
}

export function createGame(seed = 1, {
  halfWidth = UNCERTAINTY.halfWidth,
  gridPoints = UNCERTAINTY.gridPoints,
  plateaus = true,
  advanced = false,
  internalRiskWeight = advanced ? ADVANCED.internalRiskWeight : 1,
  latentRiskWeight = advanced ? ADVANCED.latentRiskWeight : 0,
} = {}) {
  let n = seed >>> 0;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  const u = ((n >>> 0) + 1) / 4294967297;
  const biasRng = { random: (seed ^ 0x27d4eb2f) >>> 0 };
  const proc = offsetProcess(halfWidth);
  // Classic: one offset ~ U(-w, w) shared by both labs, fixed all game.
  // Advanced: each lab starts from the stationary spread and the offsets then move independently.
  const shared = halfWidth * (2 * random(biasRng) - 1);
  const startBias = () => (advanced ? proc.spread * normal(biasRng) : shared);
  // Player's belief over its own offset: weighted particles. Classic: a fixed uniform grid.
  const beliefRng = { random: (seed ^ 0x165667b1) >>> 0 };
  const count = advanced ? ADVANCED.particles : gridPoints;
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
    advanced,
    internalRiskWeight,
    latentRiskWeight,
    proc,
    worldRng: { random: (seed ^ 0x61c88647) >>> 0 },
    beliefRng,
    belief: {
      offsets: Array.from({ length: count }, (_, k) =>
        advanced ? proc.spread * normal(beliefRng) : halfWidth * (-1 + (2 * k + 1) / count)),
      logWeights: new Array(count).fill(0),
    },
    events: [],
    reason: null,
    scores: null,
    // position = latent capability; available = latent after the deployment lag;
    // internal = internalFraction * available; deployed (external) = externalFraction * internal.
    // research = capability share of research funding (advanced). Classic: all fractions are 1.
    labs: [0, 1].map(() => ({
      position: 0, available: 0, internalFraction: 1, externalFraction: 1, internal: 0, deployed: 0, deployments: [],
      research: 1, bias: startBias(), speed: 0, held: false, cash: 0, profit: PROFIT.baseProfit,
    })),
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
  g.history.push({
    t: g.t, safety: g.safety, center: bandCenter(g, 0),
    deployed: g.labs.map((l) => l.deployed), internal: g.labs.map((l) => l.internal), latent: g.labs.map((l) => l.position),
  });
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

// Hazard rate under each belief particle, from the player's visible information.
function beliefRates(g) {
  const c = visibleRiskCapability(g);
  const center = bandCenter(g, 0);
  return g.belief.offsets.map((b) => hazardRate(c, center - b));
}

// Advanced-mode world dynamics for one tick: safety research, breakthroughs, offset drift.
// The true frontier only ever increases.
function advanceWorld(g, dt) {
  const A = ADVANCED;
  const rng = g.worldRng;
  g.safety += g.labs.reduce((sum, l) => sum + (1 - l.research), 0) * A.safetyResearchSpeed * dt;
  const jump = () => uniform(rng, A.breakthroughMin, A.breakthroughMax);
  let seen = 0; // jump in the player's estimate
  if (random(rng) < A.realBreakthroughRate * dt) {
    seen = jump();
    g.safety += seen;
    g.events.push({ t: g.t, size: seen, real: true });
  }
  g.labs.forEach((lab, i) => {
    lab.bias = driftOffset(lab.bias, g.proc, dt, rng);
    if (random(rng) < g.proc.falseRate * dt) {
      const size = jump();
      lab.bias += size;
      if (i === 0) {
        seen += size;
        g.events.push({ t: g.t, size, real: false });
      }
    }
  });
  // Player's belief: same offset dynamics; a seen jump was real (offset unchanged) or not (offset += jump).
  const bel = g.belief;
  bel.offsets = bel.offsets.map((b) => {
    const moved = driftOffset(b, g.proc, dt, g.beliefRng);
    return seen && random(g.beliefRng) >= g.proc.realGivenJump ? moved + seen : moved;
  });
}

// Systematic resampling when the particle weights degenerate (advanced mode only).
function resample(g) {
  const w = beliefWeights(g);
  const ess = 1 / w.reduce((s, x) => s + x * x, 0);
  if (ess >= w.length / 2) return;
  const out = [];
  let cum = w[0];
  let j = 0;
  const u0 = random(g.beliefRng) / w.length;
  for (let k = 0; k < w.length; k++) {
    const target = u0 + k / w.length;
    while (cum < target && j < w.length - 1) cum += w[++j];
    out.push(g.belief.offsets[j]);
  }
  g.belief.offsets = out;
  g.belief.logWeights = new Array(out.length).fill(0);
}

export function step(g) {
  const dt = SIM.dt;
  const rate0 = hazardRate(riskCapability(g), g.safety);
  const belief0 = beliefRates(g);
  const profit0 = g.labs.map((lab, i) => profitRate(lab.deployed, g.labs[1 - i].deployed));
  g.t += dt;
  for (const lab of g.labs) {
    const before = lab.position;
    moveLab(g, lab, dt);
    if (lab.position > before) lab.deployments.push({ at: g.t + DEPLOY_LAG, position: lab.position });
    while (lab.deployments.length && lab.deployments[0].at <= g.t + EPS) lab.available = lab.deployments.shift().position;
    applyFractions(lab);
  }
  if (g.t + EPS >= SIM.duration && g.phase === 'running') {
    g.phase = 'settling';
    for (const lab of g.labs) [lab.held, lab.speed, lab.research] = [false, 0, 0];
  }
  advanceSafety(g, dt);
  if (g.advanced) advanceWorld(g, dt);
  g.hazard += ((rate0 + hazardRate(riskCapability(g), g.safety)) / 2) * dt;
  // Survival likelihood under each particle: P(survive dt | offset) = exp(-rate dt).
  beliefRates(g).forEach((r, k) => (g.belief.logWeights[k] -= ((belief0[k] + r) / 2) * dt));
  if (g.advanced) resample(g);
  const years = dt * CLOCK.yearsPerSecond;
  g.labs.forEach((lab, i) => {
    lab.profit = profitRate(lab.deployed, g.labs[1 - i].deployed);
    lab.cash = Math.max(0, lab.cash + ((profit0[i] + lab.profit) / 2) * years);
  });
  if (g.hazard > 0 && g.hazard >= g.threshold) finish(g, 'catastrophe');
  else if (g.t + EPS >= SIM.duration && g.labs.every((l) => !l.deployments.length)) finish(g, 'completed');
  if (Math.floor((g.t + EPS) * 10) > Math.floor((g.t - dt + EPS) * 10) || !isLive(g)) record(g);
}

// Normalized posterior weights of the player's belief particles.
export function beliefWeights(g) {
  const lw = g.belief.logWeights;
  const top = Math.max(...lw);
  const w = lw.map((x) => Math.exp(x - top));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

// Catastrophe risk over the next month as the player can compute it: averaged over its belief.
export function expectedMonthlyRisk(g) {
  const w = beliefWeights(g);
  return beliefRates(g).reduce((sum, r, k) => sum + w[k] * monthlyRisk(r), 0);
}

function applyFractions(lab) {
  lab.internal = lab.internalFraction * lab.available;
  lab.deployed = lab.externalFraction * lab.internal;
}

const checkFraction = (f) => {
  if (!(f >= 0 && f <= 1)) throw Error(`Fraction must be in [0, 1], got ${f}.`);
};

// Advanced mode only. research = capability share of research funding (rest goes to safety);
// internal = fraction of available capability run internally; external = fraction of internal sold.
// Deployment changes are instant in both directions.
export function setControls(g, idx, { research, internal, external }) {
  if (!g.advanced) throw Error('Controls are only adjustable in advanced mode.');
  [research, internal, external].forEach(checkFraction);
  const lab = g.labs[idx];
  [lab.research, lab.internalFraction, lab.externalFraction] = [research, internal, external];
  applyFractions(lab);
}

// Practice bot. Same rule as the original, except it aims at a point inside its own danger zone
// instead of the hidden true frontier. Researches capability while its stopping point stays below
// target; if behind the rival's external deployment, targets 1.5 past it. Advanced: funds safety
// whenever it isn't researching capability, deploys externally up to the target, and keeps
// internal and latent headroom above it.
export function botPolicy(g, idx = 1) {
  const me = g.labs[idx];
  const rival = g.labs[1 - idx];
  const aim = bandCenter(g, idx) + g.halfWidth * (2 * UNCERTAINTY.botBandPosition - 1);
  const target = Math.max(aim, me.deployed < rival.deployed ? rival.deployed + 1.5 : 0);
  const pushing = g.advanced ? me.research > 0 : me.held;
  const held = me.position + stoppingDistance(g, me) < target + (g.advanced ? ADVANCED.botLatentHeadroom : 0) - (pushing ? 0 : 0.3);
  if (!g.advanced) return { held };
  const internal = Math.min(me.available, target + ADVANCED.botInternalHeadroom);
  const external = Math.min(internal, target);
  return {
    research: held ? 1 : 0,
    internal: me.available > 0 ? internal / me.available : 1,
    external: internal > 0 ? external / internal : 1,
  };
}

// Advance one tick with player input on lab 0 and the bot on lab 1.
// Classic input: boolean (accelerate held). Advanced input: { research, internal, external }.
export function tick(g, input) {
  if (!isLive(g)) return;
  if (g.phase === 'running') {
    const bot = botPolicy(g, 1);
    if (g.advanced) {
      setControls(g, 0, input);
      setControls(g, 1, bot);
    } else {
      if (typeof input !== 'boolean') throw Error(`Classic input must be a boolean, got ${input}.`);
      g.labs[0].held = input;
      g.labs[1].held = bot.held;
    }
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
