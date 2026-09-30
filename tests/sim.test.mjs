import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIM, createGame, tick, isLive, bandCenter, biasPosterior, expectedMonthlyRisk,
  monthlyRisk, hazardRate, frontierCapability,
} from '../src/web/sim.js';

function play(g, policy) {
  while (isLive(g)) tick(g, policy(g));
  return g;
}

const hugFrontier = (g) => g.labs[0].position < g.safety - 1;

// Reference numbers produced by running the original Pace bundle's simulation
// (seed 42, this policy, bot opponent). With halfWidth=0 our sim must match it.
test('halfWidth=0 reproduces the original game', () => {
  const g = play(createGame(42, { halfWidth: 0, gridPoints: 1 }), hugFrontier);
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
  assert.deepEqual([a.t, a.hazard, a.bias, a.labs[0].cash], [b.t, b.hazard, b.bias, b.labs[0].cash]);
});

test('true frontier always lies inside the displayed danger zone', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = createGame(seed, { halfWidth: 3 });
    assert.ok(Math.abs(g.safety - bandCenter(g)) <= 3, `seed ${seed} bias ${g.bias}`);
  }
});

test('hidden bias covers the zone roughly uniformly', () => {
  const biases = Array.from({ length: 4000 }, (_, i) => createGame(i + 1, { halfWidth: 3 }).bias);
  const mean = biases.reduce((a, b) => a + b, 0) / biases.length;
  assert.ok(Math.abs(mean) < 0.15, `mean ${mean}`);
  assert.ok(Math.min(...biases) < -2.9 && Math.max(...biases) > 2.9);
});

test('with halfWidth=0 the expected risk equals the true risk', () => {
  const g = createGame(3, { halfWidth: 0, gridPoints: 1 });
  while (isLive(g) && g.t < 40) {
    tick(g, g.t % 10 < 6);
    const truth = monthlyRisk(hazardRate(frontierCapability(g), g.safety));
    assert.ok(Math.abs(expectedMonthlyRisk(g) - truth) < 1e-12);
  }
});

test('surviving exposure shifts the posterior toward a higher (safer) frontier', () => {
  const g = createGame(11, { halfWidth: 3 });
  const prior = biasPosterior(g);
  assert.ok(prior.every((p) => Math.abs(p - 1 / prior.length) < 1e-12));
  // Sit in the upper part of the zone for a while without dying.
  g.threshold = Infinity;
  while (g.t < 60) tick(g, g.labs[0].position < bandCenter(g) + 2);
  const post = biasPosterior(g);
  assert.ok(Math.abs(post.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const mean = post.reduce((s, p, k) => s + p * g.biasGrid[k], 0);
  // Larger bias = true frontier further below the zone center = more hazard, so it loses weight.
  assert.ok(mean < -0.1, `posterior mean bias ${mean}`);
});

test('game ends by the settle deadline or catastrophe', () => {
  const g = play(createGame(5), () => false);
  assert.ok(g.t <= SIM.duration + 2 + 1e-6);
  assert.ok(['finished', 'crashed'].includes(g.phase));
});
