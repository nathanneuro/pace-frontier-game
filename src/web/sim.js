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
});

// Practice bot. Positions are within the bot's own danger zone: 0 = lower edge, 1 = upper edge.
// It sits at safePosition; when behind the rival's external deployment it chases to `lead` past
// the rival, but never beyond racePosition. Pass `bot: 'original'` to createGame for Paradigm's
// bot (aims at 0.25 and chases without limit).
// Tuned with src/tools/eval_bot.mjs: vs. careful players it roughly ties while adding ~no risk;
// vs. players deep in their zone it keeps up partially but won't follow past 0.6.
export const BOT = Object.freeze({
  safePosition: 0,
  racePosition: 0.5,
  lead: 1.5,
  // Advanced mode: internal and latent capability kept above external deployment.
  internalHeadroom: 1.5,
  latentHeadroom: 3,
});

// Advanced mode. Each lab splits research funding between capability and safety, and holds three
// tiers of capability: latent (research) >= internal (run inside the lab; drives self-improvement)
// >= external (sold to customers; earns profit; the only tier the rival can see).
export const ADVANCED = Object.freeze({
  // Internal deployment carries full risk. External deployment meets a slightly lower catastrophe
  // threshold: it counts as this much more capability (phased in over its first unit).
  // Latent-only capability carries a fraction of the risk.
  externalThresholdGap: 1,
  latentRiskWeight: 0.25,
  // Each lab has its own true safety frontier: a shared background drift (the original's frontier
  // process, scaled down) plus that lab's own safety research and real breakthroughs.
  backgroundDriftScale: 0.25,
  // Own-frontier speed from putting all research funding into safety, before the self-improvement
  // multiplier (internal capability speeds safety research exactly as it speeds capability research).
  safetyResearchSpeed: 1.2,
  // AI researchers are this efficient at safety research relative to capability research.
  safetyAiEfficiency: 0.75,
  // Uncertainty is relative: the more capable the systems, the less precisely anyone knows where the
  // frontier is. Each lab's estimate of its frontier is truth * exp(b) for a hidden log-offset b, and
  // its danger zone spans estimate * exp(+-zoneHalfWidth) (default: -33% to +49%). b mean-reverts
  // (Ornstein-Uhlenbeck) and is kicked up by false breakthroughs. Real breakthroughs raise the lab's
  // true frontier (and so its estimate). Breakthroughs are a fraction of the current frontier.
  // A lab sees the jump but not whether it was real.
  zoneHalfWidth: 0.4,
  // The offset's stationary standard deviation is zoneHalfWidth / zoneSigmas.
  zoneSigmas: 2,
  biasReversion: 0.1,
  realBreakthroughRate: 1 / 16,
  falseBreakthroughRate: 1 / 16,
  breakthroughMin: 0.05,
  breakthroughMax: 0.2,
  // Particles in the player's belief over its own offset.
  particles: 256,
  // Simple mode's pedal: holding it moves the hidden funding split from all-safety to
  // all-capability over this many game seconds; releasing moves it back at the same rate.
  pedalSeconds: 1,
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
  g.safety += distance * scale * (g.advanced ? ADVANCED.backgroundDriftScale : 1);
  m.speed += (m.target - m.speed) * blend;
}

// Advanced-mode takeoff: research = human researchers + AI researchers. The AI contribution is
// human * exp((internal - humanLevel) / scale). So the AI share of research is a logistic in
// internally deployed capability (half at human level, ~95% three scales above), and total speed
// then grows exponentially in capability, which means hyperbolically in time (finite-time
// blow-up). Past diminishingReturnsAt the returns to research diminish: the multiplier (research
// speed relative to humans alone) bends away smoothly (same slope at the knee) and approaches
// maxMultiplier without reaching it.
export const TAKEOFF = Object.freeze({
  // Research output lands after a lag: researchLagMonths divided by the lab's current AI research
  // multiplier (AI speeds its own research cycle: 3 months at the start, under a day past ~x90).
  // Research *power* is current, so rolling back internal deployment cuts it immediately.
  // Safety research takes safetyLagRatio times longer to pay off, and AI shortens its lag less:
  // only by multiplier^safetyLagExponent, so the gap widens as AI improves (x1: 1.15x the
  // capability lag; x100: 3.6x; x20000: 14x).
  researchLagMonths: 3,
  safetyLagRatio: 1.15,
  safetyLagExponent: 0.75,
  humanLevel: 24,
  scale: 8,
  diminishingReturnsAt: 5000,
  maxMultiplier: 20000,
});

// Research lag in game seconds for a lab whose AI currently multiplies research speed by
// `multiplier`, for capability research or (safety = true) safety research.
export function researchLag(multiplier, safety = false) {
  const months = TAKEOFF.researchLagMonths / 12 / CLOCK.yearsPerSecond;
  return safety ? (TAKEOFF.safetyLagRatio * months) / multiplier ** TAKEOFF.safetyLagExponent : months / multiplier;
}

// Research output in flight: { at, amount } entries. Lags shrink as AI improves, so later output
// can land before earlier output; landing is by time, not order.
function land(pipeline, t) {
  let landed = 0;
  for (let k = pipeline.length - 1; k >= 0; k--) {
    if (pipeline[k].at > t + EPS) continue;
    landed += pipeline[k].amount;
    pipeline.splice(k, 1);
  }
  return landed;
}

const inFlight = (pipeline) => pipeline.reduce((sum, p) => sum + p.amount, 0);

// Capability and safety research a lab has paid for that hasn't landed yet (advanced mode).
export const pendingResearch = (lab) => ({ capability: inFlight(lab.capabilityPipeline), safety: inFlight(lab.safetyPipeline) });

// Latent capability the lab will have once its in-flight research lands.
export const committedLatent = (lab) => lab.position + inFlight(lab.capabilityPipeline);

// Research speed relative to human researchers alone, given the internal capability doing research.
function takeoffMultiplier(capability) {
  const raw = 1 + Math.exp((Math.max(0, capability) - TAKEOFF.humanLevel) / TAKEOFF.scale);
  const { diminishingReturnsAt: knee, maxMultiplier: max } = TAKEOFF;
  return raw <= knee ? raw : knee - (max - knee) * Math.expm1(-(raw - knee) / (max - knee));
}

// Share of a lab's capability research done by its own AI (advanced mode).
export function aiResearchShare(lab) {
  return 1 / (1 + Math.exp(-(Math.max(0, lab.internal) - TAKEOFF.humanLevel) / TAKEOFF.scale));
}

// Top research speed. Classic: the original's bounded recursive self-improvement, driven by research
// position. Advanced: takeoff driven by internally deployed capability.
function topSpeed(g, lab) {
  if (g.advanced) return SPEED.initialSpeed * takeoffMultiplier(lab.internal);
  const x = Math.max(0, lab.position);
  const early = -Math.expm1(-x / SPEED.earlyRsiScale);
  const r = Math.max(0, x - SPEED.rsiThreshold) / SPEED.rsiScale;
  const late = -Math.expm1(-(r ** 2));
  const share = SPEED.earlyRsiShare * early + (1 - SPEED.earlyRsiShare) * late;
  return SPEED.initialSpeed + (SPEED.maximumSpeed - SPEED.initialSpeed) * share;
}

// Research speed relative to human researchers alone (self-improvement multiplier).
export const researchMultiplier = (g, lab) => topSpeed(g, lab) / SPEED.initialSpeed;

// Safety research gets the same AI researchers, but at safetyAiEfficiency of their capability effect.
export const safetyMultiplier = (g, lab) => 1 + ADVANCED.safetyAiEfficiency * (researchMultiplier(g, lab) - 1);

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
    const lag = researchLag(researchMultiplier(g, lab));
    lab.capabilityPipeline.push({ at: g.t + lag, amount: ((v0 + lab.speed) / 2) * dt });
    lab.position += land(lab.capabilityPipeline, g.t);
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

// Lab i's true safety frontier. Classic: one shared frontier (ownSafety stays 0).
export const frontier = (g, i = 0) => g.safety + g.labs[i].ownSafety;

// Frontier implied by an estimate (zone center) and an offset. Classic: additive. Advanced: log-offset.
const shiftBy = (g, value, offset) => (g.advanced ? value * Math.exp(offset) : value + offset);

// Lab i's estimated frontier (center of its danger zone).
export const bandCenter = (g, i = 0) => shiftBy(g, frontier(g, i), g.labs[i].bias);

// Point at `position` across the danger zone around `center`: 0 = lower edge, 1 = upper edge.
export const zonePoint = (g, center, position) => shiftBy(g, center, g.halfWidth * (2 * position - 1));

// Capability that generates catastrophe risk for one lab: internal deployment counts fully,
// external deployment as slightly more (a lower threshold), plus weighted latent-only capability.
// In classic mode this is just deployed capability.
export const labRisk = (g, l) =>
  Math.max(l.internal, l.deployed + Math.min(g.externalThresholdGap, l.deployed))
  + g.latentRiskWeight * Math.max(0, l.position - l.internal);

export const riskCapability = (g) => Math.max(0, ...g.labs.map((l) => labRisk(g, l)));

// Lab i's own catastrophe hazard rate, against its own frontier.
export const labHazardRate = (g, i) => hazardRate(labRisk(g, g.labs[i]), frontier(g, i));

// Shared catastrophe hazard. Classic: the most capable deployment against the shared frontier.
// Advanced: either lab can cause catastrophe, each against its own frontier, so rates add.
export function totalHazardRate(g) {
  if (!g.advanced) return hazardRate(riskCapability(g), g.safety);
  return labHazardRate(g, 0) + labHazardRate(g, 1);
}

// Capability behind the risk the player can estimate. Classic: everything relevant is visible.
// Advanced: only the player's own lab; the rival's frontier and hidden tiers are unknown to it.
export const playerRiskCapability = (g) =>
  (g.advanced ? labRisk(g, g.labs[0]) : Math.max(0, labRisk(g, g.labs[0]), g.labs[1].deployed));

function normal(rng) {
  return Math.sqrt(-2 * Math.log(1 - random(rng))) * Math.cos(2 * Math.PI * random(rng));
}

// Offset process for advanced mode (log units), scaled so the offset's stationary spread is
// halfWidth / 1.5 (the zone is roughly a 1.5-sigma band) and its stationary mean is zero: false
// breakthroughs push b up on average, so between them b drifts down (real progress the estimate
// hasn't noticed). A false breakthrough of relative size s moves b by log(1 + s).
function offsetProcess(halfWidth) {
  const A = ADVANCED;
  const falseRate = halfWidth > 0 ? A.falseBreakthroughRate : 0;
  const n = 1000;
  const jumps = Array.from({ length: n }, (_, k) => Math.log1p(A.breakthroughMin + ((k + 0.5) / n) * (A.breakthroughMax - A.breakthroughMin)));
  const meanJump = jumps.reduce((a, j) => a + j, 0) / n;
  const meanSqJump = jumps.reduce((a, j) => a + j * j, 0) / n;
  const jumpVariance = (falseRate * meanSqJump) / (2 * A.biasReversion);
  const spread = halfWidth / A.zoneSigmas;
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

// The original's seed -> threshold hash barely mixes small integers (seeds 1..100 give
// catastrophe thresholds near 9 instead of Exp(1)). Spread user-chosen seeds over 32 bits first.
export const mixSeed = (n) => Math.imul(n >>> 0, 2654435761) >>> 0;

// halfWidth: zone half-width; capability units in classic, log units in advanced.
export function createGame(seed = 1, {
  advanced = false,
  halfWidth = advanced ? ADVANCED.zoneHalfWidth : UNCERTAINTY.halfWidth,
  gridPoints = UNCERTAINTY.gridPoints,
  plateaus = true,
  bot = BOT,
  externalThresholdGap = advanced ? ADVANCED.externalThresholdGap : 0,
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
    bot,
    externalThresholdGap,
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
      research: advanced ? 0 : 1, safetyFunding: 0, ownSafety: 0, capabilityPipeline: [], safetyPipeline: [], accumulated: 0, bias: startBias(), speed: 0, held: false, cash: 0, profit: PROFIT.baseProfit,
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

// History snapshot (every 0.1 s). Hidden quantities are recorded for the post-game review only.
function record(g) {
  g.history.push({
    t: g.t, frontier: g.labs.map((_, i) => frontier(g, i)), center: bandCenter(g, 0),
    centers: g.labs.map((_, i) => bandCenter(g, i)),
    deployed: g.labs.map((l) => l.deployed), internal: g.labs.map((l) => l.internal), latent: g.labs.map((l) => l.position),
    cash: g.labs.map((l) => l.cash),
    research: g.labs.map((l) => l.research),
    multiplier: g.advanced ? g.labs.map((l) => researchMultiplier(g, l)) : null,
    // True hazard rate per lab (advanced) or shared (classic), cumulative hazard, and what the player saw.
    labRates: g.advanced ? [0, 1].map((i) => labHazardRate(g, i)) : [totalHazardRate(g)],
    hazard: g.hazard,
    seenRisk: expectedMonthlyRisk(g),
  });
}

function finish(g, reason) {
  g.phase = reason === 'catastrophe' ? 'crashed' : 'finished';
  g.reason = reason;
  for (const lab of g.labs) {
    lab.accumulated = lab.cash;
    if (reason === 'catastrophe') [lab.cash, lab.profit] = [0, 0];
    [lab.held, lab.speed] = [false, 0];
  }
  g.scores = g.labs.map((l) => l.cash);
}

// Hazard rate under each belief particle, from the player's information. Advanced: the player's own
// lab only. The rival's hazard doesn't depend on the player's offset, so it cancels out of the posterior.
function beliefRates(g) {
  const c = playerRiskCapability(g);
  const center = bandCenter(g, 0);
  return g.belief.offsets.map((b) => hazardRate(c, shiftBy(g, center, -b)));
}

// Advanced-mode world dynamics for one tick, per lab: own safety research, real and false
// breakthroughs, offset drift. Every lab's true frontier only ever increases.
function advanceWorld(g, dt) {
  const A = ADVANCED;
  const rng = g.worldRng;
  const jump = () => uniform(rng, A.breakthroughMin, A.breakthroughMax);
  let seen = 0; // log of the jump factor in the player's estimate
  g.labs.forEach((lab, i) => {
    if (g.phase === 'running') {
      const lag = researchLag(researchMultiplier(g, lab), true);
      lab.safetyPipeline.push({ at: g.t + lag, amount: (1 - lab.research) * A.safetyResearchSpeed * safetyMultiplier(g, lab) * dt });
    }
    lab.ownSafety += land(lab.safetyPipeline, g.t);
    lab.bias = driftOffset(lab.bias, g.proc, dt, rng);
    for (const real of [true, false]) {
      if (!(random(rng) < (real ? A.realBreakthroughRate : g.proc.falseRate) * dt)) continue;
      const size = jump();
      if (real) lab.ownSafety += size * frontier(g, i);
      else lab.bias += Math.log1p(size);
      if (i === 0) {
        seen += Math.log1p(size);
        g.events.push({ t: g.t, size, real });
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
  const rate0 = totalHazardRate(g);
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
  g.hazard += ((rate0 + totalHazardRate(g)) / 2) * dt;
  // Survival likelihood under each particle: P(survive dt | offset) = exp(-rate dt).
  beliefRates(g).forEach((r, k) => (g.belief.logWeights[k] -= ((belief0[k] + r) / 2) * dt));
  if (g.advanced) resample(g);
  const years = dt * CLOCK.yearsPerSecond;
  if (g.phase === 'running') for (const lab of g.labs) lab.safetyFunding += (1 - lab.research) * dt;
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

// Bot capability target. Original: aim a quarter into the zone; if behind, 1.5 past the rival,
// without limit. Default: sit at the safe position; chase the rival only up to the race cap.
function botTarget(g, idx) {
  const me = g.labs[idx];
  const rival = g.labs[1 - idx];
  const behind = me.deployed < rival.deployed;
  const at = (position) => zonePoint(g, bandCenter(g, idx), position);
  if (g.bot === 'original') return Math.max(at(0.25), behind ? rival.deployed + 1.5 : 0);
  const safe = at(g.bot.safePosition);
  return behind ? Math.max(safe, Math.min(rival.deployed + g.bot.lead, at(g.bot.racePosition))) : safe;
}

// Researches capability while its stopping point stays below target (0.3 hysteresis). The bot
// sees only its own zone and the rival's external deployment. Advanced: funds safety whenever it
// isn't researching capability, and keeps internal/latent headroom above external deployment while
// lowering external so its risk-weighted capability stays at the target.
export function botPolicy(g, idx = 1) {
  const me = g.labs[idx];
  const target = botTarget(g, idx);
  const pushing = g.advanced ? me.research > 0 : me.held;
  const hysteresis = pushing ? 0 : 0.3;
  if (!g.advanced) return { held: me.position + stoppingDistance(g, me) < target - hysteresis };
  const { internalHeadroom, latentHeadroom } = g.bot === 'original' ? BOT : g.bot;
  const riskMargin = Math.max(internalHeadroom, g.externalThresholdGap) + g.latentRiskWeight * (latentHeadroom - internalHeadroom);
  const externalTarget = target - (g.bot === 'original' ? 0 : riskMargin);
  const research = committedLatent(me) + stoppingDistance(g, me) < externalTarget + latentHeadroom - hysteresis ? 1 : 0;
  const internal = Math.max(0, Math.min(me.available, externalTarget + internalHeadroom));
  const external = Math.max(0, Math.min(internal, externalTarget));
  return {
    research,
    internal: me.available > 0 ? internal / me.available : 1,
    external: internal > 0 ? external / internal : 1,
  };
}

// Simple mode: the advanced dynamics driven by one pedal. Everything is deployed internally and
// externally; holding the pedal ramps the capability share of funding up, releasing ramps it down.
export function pedalControls(g, held, idx = 0) {
  if (typeof held !== 'boolean') throw Error(`Pedal input must be a boolean, got ${held}.`);
  const step = SIM.dt / ADVANCED.pedalSeconds;
  const research = Math.min(1, Math.max(0, g.labs[idx].research + (held ? step : -step)));
  return { research, internal: 1, external: 1 };
}

// Advance one tick with player input on lab 0 and the bot on lab 1.
// Classic input: boolean (accelerate held). Advanced input: { research, internal, external },
// or a boolean pedal (simple mode, see pedalControls).
export function tick(g, input) {
  if (!isLive(g)) return;
  if (g.phase === 'running') {
    const bot = botPolicy(g, 1);
    if (g.advanced) {
      setControls(g, 0, typeof input === 'boolean' ? pedalControls(g, input) : input);
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

// Calendar date at game time t. startUtc: midnight UTC of the first game day.
export function gameDate(t, startUtc = CLOCK.startUtc) {
  return new Date(startUtc + Math.floor(Math.max(0, t) * CLOCK.daysPerSecond + 1e-8) * 864e5);
}
