import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIM, createGame, tick, isLive, bandCenter, beliefWeights, expectedMonthlyRisk,
  monthlyRisk, hazardRate, riskCapability, playerRiskCapability, labRisk, aiResearchShare, TAKEOFF, stoppingDistance, researchMultiplier, safetyMultiplier, feedbackLag, CLOCK, frontier, labHazardRate, totalHazardRate, setControls, ADVANCED, mixSeed,
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
const advancedGame = (seed) => immortal(createGame(seed, { advanced: true }));
const runTo = (g, t, input) => { while (isLive(g) && g.t < t) tick(g, typeof input === 'function' ? input(g) : input); return g; };

test('advanced: deployment rolls back and restores instantly', () => {
  const g = runTo(advancedGame(9), 20, all);
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
  const latent = (research) => runTo(advancedGame(4), 40, { ...all, research }).labs[0].position;
  assert.ok(latent(1) > latent(0.5) && latent(0.5) > latent(0.1));
  assert.equal(latent(0), 0);
});

test('advanced: safety funding raises only your own frontier', () => {
  const run = (research) => runTo(advancedGame(4), 40, { ...all, research });
  const [funded, unfunded] = [run(0), run(1)];
  assert.ok(frontier(funded, 0) > frontier(unfunded, 0) + 20);
  // With no safety funding, your own frontier gains only background drift and real breakthroughs.
  const breakthroughs = unfunded.events.filter((e) => e.real).reduce((a, e) => a + e.size, 0);
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
    lab.feedback = internal;
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
  assert.equal(top(H + 10 * S), 1.5 * TAKEOFF.maxMultiplier);
});

test('advanced: AI boosts safety research, but less than capability research', () => {
  const g = createGame(1, { advanced: true });
  const lab = g.labs[0];
  for (const internal of [0, 20, 40, 60, 80]) {
    lab.feedback = internal;
    lab.safetyFeedback = internal;
    const [cap, safe] = [researchMultiplier(g, lab), safetyMultiplier(g, lab)];
    assert.ok(safe >= 1 && safe <= cap);
    assert.ok(Math.abs((safe - 1) - ADVANCED.safetyAiEfficiency * (cap - 1)) < 1e-12);
  }
});

test('advanced: feedback lag is 3 months divided by the AI research multiplier', () => {
  const months = (s) => s * CLOCK.yearsPerSecond * 12;
  assert.ok(Math.abs(months(feedbackLag(1)) - 3) < 1e-9);
  assert.ok(Math.abs(months(feedbackLag(2)) - 1.5) < 1e-9);
  assert.ok(months(feedbackLag(100)) * 30.4 < 1, 'under a day at x100');
  const g = immortal(createGame(4, { advanced: true }));
  while (g.t < 40) tick(g, all);
  const lab = g.labs[0];
  assert.ok(lab.feedback < lab.internal, 'new capability is still integrating');
});

test('advanced: rolling back internal deployment cuts feedback immediately; restoring is immediate too', () => {
  const g = runTo(advancedGame(4), 30, all);
  const lab = g.labs[0];
  const before = lab.feedback;
  assert.ok(before > 10 && before < lab.internal, 'feedback lags new capability');
  setControls(g, 0, { ...all, internal: 0.2 });
  assert.equal(lab.feedback, lab.internal);
  assert.ok(lab.feedback < before);
  runTo(g, 32, { ...all, internal: 0.2 });
  setControls(g, 0, all);
  assert.ok(lab.feedback >= before, 'already-integrated capability returns at once');
});

test('advanced: safety research integrates new AI with a 15% longer lag', () => {
  assert.ok(Math.abs(feedbackLag(3, TAKEOFF.safetyLagRatio) / feedbackLag(3) - 1.15) < 1e-12);
  const g = runTo(advancedGame(4), 25, all);
  const lab = g.labs[0];
  assert.ok(lab.safetyFeedback < lab.feedback, `safety ${lab.safetyFeedback} vs capability ${lab.feedback}`);
  setControls(g, 0, { ...all, internal: 0.1 });
  assert.equal(lab.safetyFeedback, lab.internal);
  assert.equal(lab.feedback, lab.internal);
});
