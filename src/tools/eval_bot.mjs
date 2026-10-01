// Evaluate bot variants against scripted players over many seeds.
// Usage: node src/tools/eval_bot.mjs [seeds=100]
// Writes outputs/run_<timestamp>_bot_tuning/{metadata.json,results.json,summary.md}.
import { mkdirSync, writeFileSync } from 'node:fs';
import { BOT, mixSeed, createGame, tick, isLive, bandCenter, stoppingDistance, riskCapability, frontier, labRisk } from '../web/sim.js';

const SEEDS = Number(process.argv[2] ?? 100);

const BOTS = {
  original: 'original',
  default: BOT,
  cautious: { ...BOT, safePosition: 0, racePosition: 0.25 },
  chase_center: { ...BOT, safePosition: 0, racePosition: 0.5 },
};

// Scripted players aim their capability at a position in their own zone (0 = lower edge, 1 = upper);
// Infinity = race flat out. Classic: accelerate while the stopping point is below the aim.
// Advanced: research capability while latent is below aim + 3 (else fund safety), deploy up to aim.
const PLAYERS = { idle: -Infinity, below_zone: 0, zone_center: 0.5, zone_top: 1, racer: Infinity };

function aim(g, position) {
  return bandCenter(g, 0) + g.halfWidth * (2 * position - 1);
}

function playerInput(g, position) {
  const me = g.labs[0];
  const target = aim(g, position);
  const stop = me.position + stoppingDistance(g, me);
  if (!g.advanced) return stop < target;
  const deploy = Math.max(0, Math.min(me.available, target));
  return {
    research: stop < target + 3 ? 1 : 0,
    internal: 1,
    external: me.available > 0 ? deploy / me.available : 1,
  };
}

function playOne(seed, advanced, bot, position) {
  const g = createGame(seed, { advanced, bot });
  let ahead = 0;
  let botAboveTruth = 0;
  let ticks = 0;
  while (isLive(g)) {
    tick(g, playerInput(g, position));
    if (g.phase !== 'running') continue;
    ticks++;
    if (g.labs[1].deployed >= g.labs[0].deployed) ahead++;
    if (labRisk(g, g.labs[1]) > frontier(g, 1)) botAboveTruth++;
  }
  return {
    crashed: g.reason === 'catastrophe',
    player: g.scores[0],
    bot: g.scores[1],
    botAhead: ahead / ticks,
    botAboveTruth: botAboveTruth / ticks,
    riskCapabilityEnd: riskCapability(g),
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const results = [];
for (const advanced of [false, true]) {
  for (const [botName, bot] of Object.entries(BOTS)) {
    for (const [playerName, position] of Object.entries(PLAYERS)) {
      const runs = Array.from({ length: SEEDS }, (_, i) => playOne(mixSeed(i + 1), advanced, bot, position));
      results.push({
        mode: advanced ? 'advanced' : 'classic',
        bot: botName,
        player: playerName,
        crashRate: mean(runs.map((r) => r.crashed)),
        playerPayout: mean(runs.map((r) => r.player)),
        botPayout: mean(runs.map((r) => r.bot)),
        botAhead: mean(runs.map((r) => r.botAhead)),
        botAboveTruth: mean(runs.map((r) => r.botAboveTruth)),
      });
      const r = results.at(-1);
      console.log(`${r.mode.padEnd(8)} ${r.bot.padEnd(12)} ${r.player.padEnd(12)} crash ${(100 * r.crashRate).toFixed(0).padStart(3)}%  player $${(r.playerPayout / 1e9).toFixed(1).padStart(5)}B  bot $${(r.botPayout / 1e9).toFixed(1).padStart(5)}B  bot ahead ${(100 * r.botAhead).toFixed(0).padStart(3)}%  bot above truth ${(100 * r.botAboveTruth).toFixed(0).padStart(3)}%`);
    }
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const dir = `outputs/run_${stamp}_bot_tuning`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/metadata.json`, JSON.stringify({ seeds: SEEDS, bots: BOTS, players: PLAYERS }, null, 2));
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
const rows = results.map((r) => `| ${r.mode} | ${r.bot} | ${r.player} | ${(100 * r.crashRate).toFixed(0)}% | ${(r.playerPayout / 1e9).toFixed(1)} | ${(r.botPayout / 1e9).toFixed(1)} | ${(100 * r.botAhead).toFixed(0)}% | ${(100 * r.botAboveTruth).toFixed(0)}% |`);
writeFileSync(`${dir}/summary.md`, [
  `# Bot tuning (${SEEDS} seeds per cell)`, '',
  '| mode | bot | player | crash | player $B | bot $B | bot ahead | bot above truth |',
  '|---|---|---|---|---|---|---|---|', ...rows, '',
].join('\n'));
console.log(`wrote ${dir}`);
