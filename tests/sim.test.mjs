import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIM, createGame, tick, isLive, bandCenter, beliefWeights, expectedMonthlyRisk,
  monthlyRisk, hazardRate, riskCapability, playerRiskCapability, labRisk, aiResearchShare, TAKEOFF, stoppingDistance, researchMultiplier, safetyMultiplier, researchLag, pendingResearch, committedLatent, CLOCK, frontier, labHazardRate, totalHazardRate, setControls, ADVANCED, mixSeed, zonePoint, zoneHalfWidth, uncertaintyScale, step, botTarget, releaseInterval,
} from '../src/web/sim.js';

function play(g, policy) {
  while (isLive(g)) tick(g, policy(g));
  return g;
}

const hugFrontier = (g) => g.labs[0].position < g.safety - 1;

// Reference numbers produced by running the original Pace bundle's simulation
// (seed 42, this policy, bot opponent). With halfWidth=0 our sim must match it.
test('halfWidth=0 reproduces the original game', () => {
  const g = play(createGame(42, { halfWidth: 0, gridPoints: 1, bot: 'original' }), hugFrontier);
  assert.equal(g.phase, 'finished');
  assert.ok(Math.abs(g.hazard - 0.035752) < 1e-6, `hazard ${g.hazard}`);
  assert.ok(Math.abs(g.safety - 73.0793) < 1e-4, `safety ${g.safety}`);
  assert.ok(Math.abs(g.labs[0].cash / 1.300670e10 - 1) < 1e-6, `cash0 ${g.labs[0].cash}`);
  assert.ok(Math.abs(g.labs[1].cash / 2.040235e10 - 1) < 1e-6, `cash1 ${g.labs[1].cash}`);
});

test('same seed and inputs are deterministic', () => {
  const policy = (g) => g.t % 10 < 4;
  const a = play(createGame(7), policy);
  const b = play(createGame(7), policy);
  assert.deepEqual([a.t, a.hazard, a.labs[0].bias, a.labs[0].cash], [b.t, b.hazard, b.labs[0].bias, b.labs[0].cash]);
});

test('true frontier always lies inside the displayed danger zone', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = createGame(seed, { halfWidth: 3 });
    assert.ok(Math.abs(g.safety - bandCenter(g)) <= 3, `seed ${seed} bias ${g.labs[0].bias}`);
  }
});

test('hidden bias covers the zone roughly uniformly', () => {
  const biases = Array.from({ length: 4000 }, (_, i) => createGame(i + 1, { halfWidth: 3 }).labs[0].bias);
  const mean = biases.reduce((a, b) => a + b, 0) / biases.length;
  assert.ok(Math.abs(mean) < 0.15, `mean ${mean}`);
  assert.ok(Math.min(...biases) < -2.9 && Math.max(...biases) > 2.9);
});

test('with halfWidth=0 the expected risk equals the true risk', () => {
  const g = createGame(3, { halfWidth: 0, gridPoints: 1 });
  while (isLive(g) && g.t < 40) {
    tick(g, g.t % 10 < 6);
    const truth = monthlyRisk(hazardRate(riskCapability(g), g.safety));
    assert.ok(Math.abs(expectedMonthlyRisk(g) - truth) < 1e-12);
  }
});

test('surviving exposure shifts the posterior toward a higher (safer) frontier', () => {
  const g = createGame(11, { halfWidth: 3 });
  const prior = beliefWeights(g);
  assert.ok(prior.every((p) => Math.abs(p - 1 / prior.length) < 1e-12));
  // Sit in the upper part of the zone for a while without dying.
  g.threshold = Infinity;
  while (g.t < 60) tick(g, g.labs[0].position < bandCenter(g) + 2);
  const post = beliefWeights(g);
  assert.ok(Math.abs(post.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const mean = post.reduce((s, p, k) => s + p * g.belief.offsets[k], 0);
  // Larger bias = true frontier further below the zone center = more hazard, so it loses weight.
  assert.ok(mean < -0.1, `posterior mean bias ${mean}`);
});

test('game ends by the settle deadline or catastrophe', () => {
  const g = play(createGame(5), () => false);
  assert.ok(g.t <= SIM.duration + 2 + 1e-6);
  assert.ok(['finished', 'crashed'].includes(g.phase));
});

// ---- advanced mode ----

const all = { research: 1, internal: 1, external: 1 };
const immortal = (g) => Object.assign(g, { threshold: Infinity });
// Mechanism tests start from a standstill (no pre-game research in flight) unless they say otherwise.
const advancedGame = (seed, momentum = false) => immortal(createGame(seed, { advanced: true, momentum }));
const runTo = (g, t, input) => { while (isLive(g) && g.t < t) tick(g, typeof input === 'function' ? input(g) : input); return g; };

test('advanced: deployment rolls back and restores instantly', () => {
  const g = runTo(advancedGame(9), 24, all);
  const { available } = g.labs[0];
  assert.ok(available > 5);
  setControls(g, 0, { research: 1, internal: 0.5, external: 0.4 });
  assert.equal(g.labs[0].internal, 0.5 * available);
  assert.equal(g.labs[0].deployed, 0.4 * 0.5 * available);
  setControls(g, 0, all);
  assert.equal(g.labs[0].deployed, available);
});

test('advanced: internal deployment speeds latent growth (RSI); external does not', () => {
  const latent = (input) => runTo(advancedGame(4), 60, input).labs[0].position;
  const base = latent(all);
  assert.ok(base > latent({ ...all, internal: 0.2 }) + 5);
  assert.equal(latent({ ...all, external: 0.2 }), base);
});

test('advanced: capability share of funding sets research speed', () => {
  const start = advancedGame(4).labs[0].position;
  const latent = (research) => runTo(advancedGame(4), 40, { ...all, research }).labs[0].position - start;
  assert.ok(latent(1) > latent(0.5) && latent(0.5) > latent(0.1));
  assert.equal(latent(0), 0);
});

test('advanced: safety funding raises only your own frontier', () => {
  const run = (research) => runTo(advancedGame(4), 40, { ...all, research });
  const [funded, unfunded] = [run(0), run(1)];
  assert.ok(frontier(funded, 0) > frontier(unfunded, 0) + 20 * ADVANCED.speedScale);
  // With no safety funding, your own frontier gains only background drift and real breakthroughs.
  const breakthroughs = unfunded.events.filter((e) => !e.retracted).reduce((a, e) => a + e.gain, 0);
  assert.ok(Math.abs(unfunded.labs[0].ownSafety - breakthroughs) < 1e-9);
});

test('advanced: external earns more than internal-only', () => {
  const cash = (input) => runTo(advancedGame(4), 30, input).labs[0].cash;
  assert.ok(cash(all) > cash({ ...all, external: 0.3 }));
});

test('advanced: internal counts fully, external slightly more, latent-only a fraction', () => {
  const g = runTo(advancedGame(4), 40, all);
  const lab = g.labs[0];
  const risk = (internal, external) => {
    setControls(g, 0, { research: 1, internal, external });
    return labRisk(g, lab);
  };
  const latentOnly = ADVANCED.latentRiskWeight * (lab.position - lab.available);
  assert.ok(Math.abs(risk(1, 0) - (lab.available + latentOnly)) < 1e-9);
  assert.ok(Math.abs(risk(1, 1) - (lab.available + ADVANCED.externalThresholdGap + latentOnly)) < 1e-9);
  assert.ok(Math.abs(risk(0, 0) - ADVANCED.latentRiskWeight * lab.position) < 1e-9);
  // The external gap phases in, so a sliver of external deployment adds only a sliver of risk.
  const sliver = 0.1 / lab.available;
  assert.ok(Math.abs(risk(1, sliver) - risk(1, 0)) < 1e-9);
  assert.ok(Math.abs(risk(0.5, 1) - risk(0.5, 0) - ADVANCED.externalThresholdGap) < 1e-9);
});

test('advanced: each lab risks catastrophe against its own frontier; player estimates only its own', () => {
  const g = runTo(advancedGame(4), 40, all);
  setControls(g, 0, { research: 1, internal: 0, external: 0 });
  setControls(g, 1, { research: 1, internal: 1, external: 0.2 });
  assert.equal(playerRiskCapability(g), ADVANCED.latentRiskWeight * g.labs[0].position);
  assert.equal(totalHazardRate(g), labHazardRate(g, 0) + labHazardRate(g, 1));
});

test('advanced: frontier never decreases; truth wanders around and sometimes out of each zone', () => {
  let outside = 0;
  let samples = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const g = advancedGame(seed);
    let last = [0, 1].map((i) => frontier(g, i));
    while (isLive(g)) {
      tick(g, { research: 0.7, internal: 1, external: 1 });
      const now = [0, 1].map((i) => frontier(g, i));
      assert.ok(now.every((f, i) => f >= last[i]), `seed ${seed}: a frontier fell at t=${g.t}`);
      last = now;
      for (const lab of g.labs) {
        samples++;
        if (Math.abs(lab.bias) > g.halfWidth) outside++;
      }
    }
    for (const e of g.events) kinds.add(e.real);
    assert.notEqual(g.labs[0].bias, g.labs[1].bias);
  }
  const share = outside / samples;
  assert.ok(share > 0.03 && share < 0.4, `share of time outside zone ${share}`);
  assert.deepEqual([...kinds].sort(), [false, true]);
});

test('advanced: belief weights stay normalized and the run is deterministic', () => {
  const a = runTo(advancedGame(12), 50, all);
  const b = runTo(advancedGame(12), 50, all);
  const w = beliefWeights(a);
  assert.ok(Math.abs(w.reduce((x, y) => x + y, 0) - 1) < 1e-12);
  assert.deepEqual(a.belief.offsets, b.belief.offsets);
  assert.equal(expectedMonthlyRisk(a), expectedMonthlyRisk(b));
});

test('mode inputs are validated', () => {
  assert.throws(() => setControls(createGame(1), 0, all), /advanced mode/);
  assert.throws(() => tick(createGame(1), all), /boolean/);
  assert.throws(() => tick(createGame(1, { advanced: true }), { ...all, research: 2 }), /\[0, 1\]/);
});

test('catastrophe zeroes payouts but keeps what each lab accumulated', () => {
  const g = play(createGame(1), () => true);
  assert.equal(g.reason, 'catastrophe');
  assert.deepEqual(g.scores, [0, 0]);
  assert.ok(g.labs[0].accumulated > 1e10, `accumulated ${g.labs[0].accumulated}`);
});

test('mixed small seeds give Exp(1) catastrophe thresholds', () => {
  const t = Array.from({ length: 4000 }, (_, i) => createGame(mixSeed(i + 1)).threshold);
  const mean = t.reduce((a, b) => a + b, 0) / t.length;
  assert.ok(Math.abs(mean - 1) < 0.08, `mean threshold ${mean}`);
});

test('advanced takeoff: AI share is half at human level, dominant above, and speed grows exponentially', () => {
  const g = createGame(1, { advanced: true });
  const lab = g.labs[0];
  const at = (internal) => {
    lab.internal = internal;
    lab.speed = 0;
    return [aiResearchShare(lab), stoppingDistance(g, { ...lab, speed: 1 })];
  };
  const H = TAKEOFF.humanLevel;
  const S = TAKEOFF.scale;
  assert.ok(Math.abs(at(0)[0] - 1 / (1 + Math.exp(H / S))) < 1e-12 && at(0)[0] < 0.05);
  assert.ok(Math.abs(at(H)[0] - 0.5) < 1e-12);
  assert.ok(at(H + 3 * S)[0] > 0.95);
  // stopping distance at unit speed is 1 / (2 * decel * top), so it reveals top speed.
  const top = (internal) => 1 / (2 * SIM.deceleration * at(internal)[1]);
  assert.ok(Math.abs(top(H) / top(0) - 2 / (1 + Math.exp(-H / S))) < 1e-9);
  // Above human level each extra `scale` of capability multiplies research speed by ~e.
  assert.ok(Math.abs(top(H + 4 * S) / top(H + 3 * S) - (1 + Math.E ** 4) / (1 + Math.E ** 3)) < 1e-9);
  assert.ok(Math.abs(top(H + 5 * S) / top(H + 4 * S) - (1 + Math.E ** 5) / (1 + Math.E ** 4)) < 1e-9);
  // Diminishing returns: unchanged up to the knee, then bends smoothly toward the asymptote.
  const { diminishingReturnsAt: knee, maxMultiplier: max } = TAKEOFF;
  const kneeAt = H + S * Math.log(knee - 1);
  const base = 1.5 * ADVANCED.speedScale; // human-only top research speed
  assert.ok(Math.abs(top(kneeAt - 0.5) / base - (1 + Math.exp((kneeAt - 0.5 - H) / S))) < 1e-6);
  const slope = (x) => (top(x + 1e-4) - top(x - 1e-4)) / 2e-4;
  assert.ok(Math.abs(slope(kneeAt - 1e-3) / slope(kneeAt + 1e-3) - 1) < 1e-3, 'smooth at the knee');
  const late = [H + 10 * S, H + 11 * S, H + 12 * S].map((x) => top(x) / base);
  assert.ok(late.every((m, k) => m < max && (!k || m > late[k - 1])), `late multipliers ${late}`);
  assert.ok(late[0] < 0.8 * max && late.at(-1) > 0.999 * max, `late multipliers ${late}`);
  assert.ok(top(1e6) / base <= max);
});

test('advanced: AI boosts safety research, but less than capability research', () => {
  const g = createGame(1, { advanced: true });
  const lab = g.labs[0];
  for (const internal of [0, 20, 40, 60, 80]) {
    lab.internal = internal;
    const [cap, safe] = [researchMultiplier(g, lab), safetyMultiplier(g, lab)];
    assert.ok(safe >= 1 && safe <= cap);
    assert.ok(Math.abs((safe - 1) - ADVANCED.safetyAiEfficiency * (cap - 1)) < 1e-12);
  }
});


test('advanced: research output lands after 3 months / AI multiplier; safety later, increasingly so', () => {
  const months = (s) => s * CLOCK.yearsPerSecond * 12;
  assert.ok(Math.abs(months(researchLag(1)) - 3) < 1e-9);
  assert.ok(Math.abs(months(researchLag(2)) - 1.5) < 1e-9);
  assert.ok(Math.abs(researchLag(1, true) / researchLag(1) - 1.15) < 1e-12);
  const ratios = [1, 10, 100, 20000].map((m) => researchLag(m, true) / researchLag(m));
  assert.ok(ratios.every((r, k) => !k || r > ratios[k - 1]), `ratios ${ratios}`);
  assert.ok(ratios.at(-1) > 10, `ratio at x20000 ${ratios.at(-1)}`);
  assert.ok(months(researchLag(100)) * 30.4 < 1, 'under a day at x100');
  // Nothing lands for the first ~3 months of research.
  const g = advancedGame(4);
  const start = g.labs[0].position;
  const lag = researchLag(researchMultiplier(g, g.labs[0]));
  runTo(g, lag * 0.9, all);
  assert.equal(g.labs[0].position, start);
  assert.ok(pendingResearch(g.labs[0]).capability > 0);
  runTo(g, lag * 1.2, all);
  assert.ok(g.labs[0].position > start);
});

test('advanced: switching funding to safety stops new capability output, but in-flight research still lands', () => {
  const g = runTo(advancedGame(4), 20, all);
  const lab = g.labs[0];
  const committed = committedLatent(lab);
  runTo(g, 40, { ...all, research: 0 });
  assert.ok(lab.position > committed - 2 && lab.position < committed + 2, `${lab.position} vs ${committed}`);
  assert.ok(pendingResearch(lab).safety > 0 || lab.ownSafety > 0);
});

test('advanced: rolling back internal deployment cuts research power immediately', () => {
  const g = runTo(advancedGame(4), 30, all);
  const before = researchMultiplier(g, g.labs[0]);
  setControls(g, 0, { ...all, internal: 0.2 });
  assert.ok(researchMultiplier(g, g.labs[0]) < before);
});

test('simple mode: the pedal ramps funding to capabilities in ~1 s and back at the same rate', () => {
  const g = advancedGame(4);
  assert.equal(g.labs[0].research, ADVANCED.startingResearch);
  runTo(g, 1, false);
  assert.equal(g.labs[0].research, 0);
  runTo(g, 1.5, true);
  assert.ok(Math.abs(g.labs[0].research - 0.5) < 0.02, `research ${g.labs[0].research}`);
  runTo(g, 2.5, true);
  assert.equal(g.labs[0].research, 1);
  assert.equal(g.labs[0].internalFraction * g.labs[0].externalFraction, 1);
  runTo(g, 3, false);
  assert.ok(Math.abs(g.labs[0].research - 0.5) < 0.02, `research ${g.labs[0].research}`);
  runTo(g, 4, false);
  assert.equal(g.labs[0].research, 0);
});

test('advanced: danger zone and breakthroughs scale with the frontier', () => {
  const g = advancedGame(4);
  const width = (center) => zonePoint(g, center, g.halfWidth, 1) - zonePoint(g, center, g.halfWidth, 0);
  assert.ok(Math.abs(width(1000) / width(10) - 100) < 1e-9);
  assert.ok(Math.abs(zonePoint(g, 10, g.halfWidth, 0.5) - 10) < 1e-12);
  for (const lab of g.labs) lab.ownSafety = 500;
  const before = frontier(g, 0);
  while (g.t < 60 && !g.events.some((e) => e.real && e.t > 0)) step(g);
  const e = g.events.find((x) => x.real);
  assert.ok(e && e.size >= ADVANCED.breakthroughMin && e.size <= ADVANCED.breakthroughMax);
  assert.ok(frontier(g, 0) - before > ADVANCED.breakthroughMin * before * 0.99);
});

test('advanced: uncertainty grows once AI research outpaces humans', () => {
  const g = advancedGame(4);
  const lab = g.labs[0];
  const at = (internal) => {
    lab.internal = internal;
    return [researchMultiplier(g, lab), uncertaintyScale(g, 0), zoneHalfWidth(g, 0), bandCenter(g, 0)];
  };
  const [m0, s0, w0] = at(0);
  const widen = ADVANCED.playerZoneWidening;
  assert.ok(m0 < 1.1 && s0 < 1.02 && Math.abs(w0 - widen * g.halfWidth) < 0.01);
  const [m1, s1, w1, c1] = at(TAKEOFF.humanLevel + 76);
  assert.ok(Math.abs(s1 - (1 + ADVANCED.speedUncertainty * Math.log10(m1))) < 1e-12 && s1 > 2);
  assert.ok(Math.abs(w1 - widen * g.halfWidth * s1) < 1e-12);
  // The estimate's error scales too: center = truth * exp(bias * scale).
  assert.ok(Math.abs(c1 - frontier(g, 0) * Math.exp(lab.bias * s1)) < 1e-9);
  assert.equal(uncertaintyScale(createGame(1), 0), 1);
});

test('advanced: the player zone is wider than the bot zone; truth is almost never outside it', () => {
  let outside = 0;
  let samples = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const g = advancedGame(seed);
    assert.ok(Math.abs(zoneHalfWidth(g, 0) / zoneHalfWidth(g, 1) - ADVANCED.playerZoneWidening) < 1e-12);
    while (isLive(g)) {
      tick(g, { research: 0.7, internal: 1, external: 1 });
      samples++;
      const log = Math.log(frontier(g, 0) / bandCenter(g, 0));
      if (Math.abs(log) > zoneHalfWidth(g, 0)) outside++;
    }
  }
  assert.ok(outside / samples < 0.01, `share outside the player zone ${outside / samples}`);
});

test('cumulative risk is tracked per lab and as the player estimated it', () => {
  const g = runTo(advancedGame(4), 60, all);
  assert.ok(Math.abs(g.labHazards[0] + g.labHazards[1] - g.hazard) < 1e-9 * Math.max(1, g.hazard));
  assert.ok(g.seenHazards.every((h) => h > 0) && g.labHazards[0] > 0);
  const c = play(createGame(5), () => true);
  assert.ok(c.seenHazards.every((h) => h > 0) && c.labHazards.every((h) => h === 0));
});

test('advanced: both labs start with research momentum already landing', () => {
  const g = advancedGame(4, true);
  for (const lab of g.labs) {
    assert.equal(lab.research, ADVANCED.startingResearch);
    assert.ok(lab.speed > 0 && pendingResearch(lab).capability > 0 && pendingResearch(lab).safety > 0);
  }
  const before = frontier(g, 0) - g.safety;
  runTo(g, 1, { research: 0, internal: 1, external: 1 });
  // Output lands from the start, even after the player switches all funding to safety.
  assert.ok(g.labs[0].position > 0.5, `latent ${g.labs[0].position}`);
  assert.ok(frontier(g, 0) - g.safety > before);
  assert.equal(createGame(4).labs[0].capabilityPipeline.length, 0);
});

test('bot: stays ahead of a careful player and anticipates a fast-growing one', () => {
  // Careful pedal player (stays below its zone): the bot keeps its external deployment ahead.
  const g = advancedGame(4, true);
  let ahead = 0;
  let ticks = 0;
  while (isLive(g) && g.t < 60) {
    const me = g.labs[0];
    tick(g, labRisk(g, me) + committedLatent(me) - me.position + stoppingDistance(g, me) < zonePoint(g, bandCenter(g), zoneHalfWidth(g, 0), 0));
    ticks++;
    if (g.labs[1].deployed >= g.labs[0].deployed) ahead++;
  }
  assert.ok(ahead / ticks > 0.8, `bot ahead ${ahead / ticks}`);
  // Same rival deployment now, but growing: the bot aims ahead of where it's heading.
  const target = (rate) => {
    const h = advancedGame(4, true);
    // Bot's zone centered at 80: safe floor ~54, race cap 80, so neither binds below.
    h.labs[1].bias = 0;
    h.labs[1].ownSafety = 80 - h.safety;
    h.labs[0].deployed = 50;
    h.labs[1].watch = { last: 50, rate };
    return botTarget(h, 1);
  };
  const [still, growing] = [target(0), target(1)];
  assert.ok(still > 50 * 1.05 && still < 60, `target vs a still rival ${still}`);
  assert.ok(growing > still + 10, `target vs a growing rival ${growing}`);
});

test('advanced: re-examined breakthroughs can drop the estimate suddenly; truth never falls', () => {
  let retractions = 0;
  let wrong = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const g = advancedGame(seed);
    let center = bandCenter(g, 0);
    let truth = frontier(g, 0);
    while (isLive(g)) {
      const n = g.events.length;
      tick(g, { research: 0.7, internal: 1, external: 1 });
      assert.ok(frontier(g, 0) >= truth);
      for (const e of g.events.slice(n).filter((x) => x.retracted)) {
        retractions++;
        if (e.real) wrong++;
        // Same tick: the estimate falls (by about the jump), with the truth unchanged.
        assert.ok(bandCenter(g, 0) < center, `seed ${seed}: estimate didn't drop at a retraction`);
      }
      [center, truth] = [bandCenter(g, 0), frontier(g, 0)];
    }
  }
  assert.ok(retractions >= 10 && wrong >= 1 && wrong < retractions, `retractions ${retractions}, wrong ${wrong}`);
});

test('advanced: capability ships in discrete releases, more often as AI speeds up', () => {
  const g = advancedGame(4, true);
  const steps = [];
  let last = g.labs[0].available;
  while (g.t < 50) {
    tick(g, all);
    if (g.labs[0].available !== last) steps.push(g.t);
    last = g.labs[0].available;
  }
  const gaps = steps.slice(1).map((t, k) => t - steps[k]);
  const interval = releaseInterval(g, g.labs[0]);
  assert.ok(steps.length >= 4 && gaps.every((d) => d > 0.8 * interval), `release gaps ${gaps}`);
  const lab = g.labs[0];
  const at = (internal) => releaseInterval(g, { ...lab, internal });
  assert.ok(at(TAKEOFF.humanLevel + 40) < at(0) / 50);
});

test('advanced: the world starts at ~70% of human level, slightly inside the danger zone', () => {
  for (const seed of [1, 2, 3]) {
    const g = createGame(mixSeed(seed), { advanced: true });
    for (const [i, lab] of g.labs.entries()) {
      assert.ok(Math.abs(lab.deployed / TAKEOFF.humanLevel - ADVANCED.startingCapability) < 1e-9);
      assert.ok(Math.abs(frontier(g, i) / lab.deployed - ADVANCED.startingFrontierRatio) < 0.05);
      assert.equal(labHazardRate(g, i), 0);
    }
  }
});
