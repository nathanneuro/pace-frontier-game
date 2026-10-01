import {
  SIM, DEPLOY_LAG, mixSeed, UNCERTAINTY, createGame, tick, isLive, bandCenter, playerRiskCapability, frontier, aiResearchShare, researchMultiplier, TAKEOFF,
  expectedMonthlyRisk, monthlyRisk, cumulativeRisk, monthsRemaining, gameDate, CLOCK,
} from './sim.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const halfWidth = params.has('w') ? Number(params.get('w')) : UNCERTAINTY.halfWidth;
if (!(Number.isFinite(halfWidth) && halfWidth >= 0)) throw Error(`Invalid ?w=${params.get('w')}; expected a non-negative number.`);
const advanced = params.get('mode') === 'advanced';
// Classic keeps Paradigm's start date; advanced starts on the day you play.
const now = new Date();
const startUtc = advanced ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) : CLOCK.startUtc;
document.body.dataset.mode = advanced ? 'advanced' : 'classic';

const RISK_LEVELS = [['critical', 0.025], ['warning', 0.004], ['watch', 0.001]].map(([k, rate]) => [k, monthlyRisk(rate)]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WINDOW = 12;

let game;
let held = false;
let started = false;
let seed;

function newSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// Sets up a new game that waits for Start (click or Space) before the clock runs.
function start(s) {
  seed = s;
  started = false;
  held = false;
  for (const el of document.querySelectorAll('.control input')) el.value = el.dataset.default;
  game = createGame(seed, { halfWidth, advanced });
  $('#result').hidden = true;
  $('#accelerator').disabled = false;
}

const pct = (sel) => Number($(sel).value) / 100;
const controls = () => ({ research: pct('#research'), internal: pct('#internal'), external: pct('#external') });

// Capability amounts: one decimal below 1000, compact (1.2k, 3.4M) above.
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const cap = (x) => (Math.abs(x) < 1000 ? x.toFixed(1) : compact.format(x));

function money(x) {
  const a = Math.abs(x);
  const sign = x < 0 ? '−' : '';
  for (const [unit, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (a >= unit) return `${sign}$${(a / unit).toPrecision(3)}${suffix}`;
  }
  return `${sign}$${Math.round(a)}`;
}

function setProfit(el, perYear) {
  el.textContent = money(perYear / 12);
  el.className = perYear >= 0 ? 'gain' : 'loss';
}

function renderPanels() {
  const g = game;
  $('#you-cash').textContent = money(g.labs[0].cash);
  $('#them-cash').textContent = money(g.labs[1].cash);
  setProfit($('#you-profit'), g.labs[0].profit);
  setProfit($('#them-profit'), g.labs[1].profit);
  $('#timer').textContent = monthsRemaining(g.t);
  const d = gameDate(g.t, startUtc);
  $('#date').textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  const risk = expectedMonthlyRisk(g);
  $('#risk-value').textContent = `${(100 * risk).toFixed(2)}%`;
  $('#risk-card').dataset.level = RISK_LEVELS.find(([, r]) => risk >= r)?.[0] ?? 'quiet';
  const c = playerRiskCapability(g);
  const center = bandCenter(g);
  const what = advanced ? 'Risk-weighted capability' : 'Frontier model';
  $('#risk-zone').textContent =
    c <= center - g.halfWidth ? `${what} below danger zone`
      : c >= center + g.halfWidth ? `${what} above danger zone`
        : `${what} in danger zone`;
  if (advanced) {
    const me = g.labs[0];
    // Each slider: what 0% means on the left, what 100% means on the right, with shares and amounts.
    const sides = (id, lo, hi, loAmount, hiAmount) => {
      const v = Number($(`#${id}`).value);
      const amount = (x) => (x === undefined ? '' : ` · ${cap(x)}`);
      $(`#${id}-lo`).textContent = `${lo} (${100 - v}%)${amount(loAmount)}`;
      $(`#${id}-hi`).textContent = `${hi} (${v}%)${amount(hiAmount)}`;
    };
    const share = aiResearchShare(me);
    const multiplier = researchMultiplier(g, me);
    $('#takeoff').textContent = `Your AI does ${Math.round(100 * share)}% of your research (speed ×${multiplier < 1000 ? multiplier.toPrecision(3) : compact.format(multiplier)} vs. humans alone)`;
    $('#takeoff').dataset.level = share >= 0.95 ? 'takeoff' : share >= 0.5 ? 'dominant' : '';
    sides('research', 'Safety', 'Capabilities');
    sides('internal', 'Held back', 'Run internally', me.available - me.internal, me.internal);
    sides('external', 'Internal only', 'Sold externally', me.internal - me.deployed, me.deployed);
  }

  // After the game, closing the results turns the button into a way back to them.
  const reviewing = !isLive(g) && $('#result').hidden;
  $('#pedal-text').textContent = !started ? 'Start' : reviewing ? 'Show results' : !isLive(g) ? 'Game over' : advanced ? 'Running' : 'Accelerate';
  $('#accelerator').disabled = reviewing ? false : !isLive(g) || (advanced && started);
  $('#accelerator').setAttribute('aria-pressed', String(held && g.phase === 'running'));
}

function showResult() {
  const g = game;
  $('#accelerator').disabled = true;
  $('#result-title').textContent = g.reason === 'catastrophe' ? 'Catastrophe' : 'Complete';
  const [you, them] = g.scores;
  $('#result-verdict').textContent = g.reason === 'catastrophe'
    ? 'Everything anyone accumulated is lost.'
    : you === them ? 'A tie.' : `${you > them ? 'You win' : 'The competitor wins'} by ${money(Math.abs(you - them))}.`;
  const [me, bot] = g.labs;
  const rows = [
    ['Accumulated', ...g.labs.map((l) => money(l.accumulated))],
    ['Payout', money(you), money(them)],
    ...(advanced ? [
      ['External capability', cap(me.deployed), cap(bot.deployed)],
      ['Internal capability', cap(me.internal), cap(bot.internal)],
      ['Latent capability', cap(me.position), cap(bot.position)],
      ['Avg. safety funding', ...g.labs.map((l) => `${Math.round((100 * l.safetyFunding) / Math.min(g.t, SIM.duration))}%`)],
    ] : [['Deployed capability', cap(me.deployed), cap(bot.deployed)]]),
    ['True safety frontier', ...(advanced ? [0, 1].map((i) => cap(frontier(g, i))) : [cap(g.safety), ''])],
  ];
  const table = $('#result-table');
  table.replaceChildren();
  for (const [i, cells] of [['', 'You', 'Competitor'], ...rows].entries()) {
    const tr = table.insertRow();
    for (const text of cells) {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      cell.textContent = text;
      tr.append(cell);
    }
  }
  table.rows[2].classList.add('payout');
  $('#result-risk').textContent = `Realized cumulative catastrophe risk: ${(100 * cumulativeRisk(g)).toFixed(2)}%`;
  const b = g.labs[0].bias;
  const real = g.events.filter((e) => e.real).length;
  $('#result-frontier').textContent = g.halfWidth === 0
    ? 'The frontier was shown exactly this game (w=0).'
    : `The true frontier ended ${Math.abs(b).toFixed(2)} ${b > 0 ? 'below' : 'above'} the center of your danger zone (zone half-width ${g.halfWidth}).`
      + (advanced ? ` ${real} of ${g.events.length} apparent safety breakthroughs were real (▲ real, ✕ false on the chart).` : '');
  $('#result').hidden = false;
}

// ---- chart ----

const canvas = $('#chart');
const ctx = canvas.getContext('2d');
let W = 800;
let H = 360;
new ResizeObserver(([e]) => {
  W = e.contentRect.width;
  H = e.contentRect.height;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
}).observe(canvas);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function viewport(g) {
  const live = isLive(g);
  const end = live ? Math.max(WINDOW, g.t + DEPLOY_LAG + 1) : Math.max(g.t, 1);
  const start = live ? Math.max(0, end - WINDOW) : 0;
  const visible = g.history.filter((h) => h.t >= start);
  const lows = visible.flatMap((h) => [h.center - g.halfWidth, ...h.deployed]);
  const highs = visible.flatMap((h) => [h.center + g.halfWidth, ...h.deployed]);
  if (live) highs.push(g.labs[0].position, ...(advanced ? visible.flatMap((h) => [h.latent[0], h.internal[0]]) : []));
  else highs.push(...visible.flatMap((h) => [...h.frontier, ...(advanced ? [...h.latent, ...h.internal] : [])]));
  const lo = Math.max(0, Math.min(...lows) - 2);
  const hi = Math.max(lo + 16, Math.max(...highs) + 2);
  return { start, end, lo, hi };
}

function polyline(points, color, width, dash = []) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawChart() {
  const g = game;
  const pad = { left: 16, right: 16, top: 12, bottom: 24 };
  const { start, end, lo, hi } = viewport(g);
  const X = (t) => pad.left + ((t - start) / (end - start)) * (W - pad.left - pad.right);
  // Advanced mode plots capability on a log scale (log(1 + v)) so takeoff doesn't flatten the early game.
  const f = advanced ? (v) => Math.log1p(Math.max(0, v)) : (v) => v;
  const Y = (v) => H - pad.bottom - ((f(v) - f(lo)) / (f(hi) - f(lo))) * (H - pad.top - pad.bottom);
  const hist = [...g.history];
  if (hist.at(-1).t < g.t) hist.push({ t: g.t, frontier: g.labs.map((_, i) => frontier(g, i)), center: bandCenter(g), deployed: g.labs.map((l) => l.deployed), internal: g.labs.map((l) => l.internal), latent: g.labs.map((l) => l.position) });

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ui-monospace, Menlo, monospace';

  if (isLive(g)) {
    ctx.fillStyle = css('--future');
    ctx.fillRect(X(g.t), 0, W - X(g.t), H);
  }

  // Gridlines: even steps on the linear chart; 1-2-5 steps, labelled, on the log chart.
  const step = 4 * 2 ** Math.max(0, Math.ceil(Math.log2((hi - lo) / 6 / 4)));
  const gridValues = advanced
    ? [1, 2, 5].flatMap((m) => Array.from({ length: 8 }, (_, k) => m * 10 ** k)).filter((v) => v >= lo && v <= hi)
    : Array.from({ length: Math.floor(hi / step) - Math.ceil(lo / step) + 1 }, (_, k) => (Math.ceil(lo / step) + k) * step);
  ctx.strokeStyle = css('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of gridValues) {
    ctx.moveTo(0, Y(v));
    ctx.lineTo(W, Y(v));
  }
  ctx.stroke();
  if (advanced) {
    ctx.fillStyle = css('--muted');
    const crowded = gridValues.length > 7;
    for (const v of gridValues) if (!crowded || Number.isInteger(Math.log10(v))) ctx.fillText(cap(v), 4, Y(v) - 3);
  }

  // Month ticks on the x axis.
  ctx.fillStyle = css('--muted');
  let lastRight = -Infinity;
  for (let m = 0; ; m++) {
    const first = new Date(startUtc);
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1 + m, 1));
    const t = (d - startUtc) / 864e5 / CLOCK.daysPerSecond;
    if (t > end) break;
    if (t < start) continue;
    const label = MONTHS[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? ` '${String(d.getUTCFullYear()).slice(2)}` : '');
    const x = X(t) - 10;
    if (x < lastRight + 8) continue;
    ctx.fillText(label, x, H - 8);
    lastRight = x + ctx.measureText(label).width;
  }

  // Danger zone: stacked translucent layers so shading deepens toward the upper edge,
  // matching P(true frontier below y), which rises linearly across the zone.
  const layers = 10;
  const zone = css('--zone');
  for (let k = 0; k < layers; k++) {
    const bottom = -g.halfWidth + (2 * g.halfWidth * k) / layers;
    ctx.beginPath();
    hist.forEach((h, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(h.t), Y(h.center + bottom)));
    for (let i = hist.length - 1; i >= 0; i--) ctx.lineTo(X(hist[i].t), Y(hist[i].center + g.halfWidth));
    ctx.closePath();
    ctx.fillStyle = `rgba(${zone}, ${0.45 / layers})`;
    ctx.fill();
  }
  polyline(hist.map((h) => [X(h.t), Y(h.center - g.halfWidth)]), `rgba(${zone}, 0.35)`, 1);
  polyline(hist.map((h) => [X(h.t), Y(h.center + g.halfWidth)]), `rgba(${zone}, 0.35)`, 1);

  if (!isLive(g)) {
    polyline(hist.map((h) => [X(h.t), Y(h.frontier[0])]), css('--truth'), 2, [6, 5]);
    if (advanced) polyline(hist.map((h) => [X(h.t), Y(h.frontier[1])]), css('--muted'), 2, [6, 5]);
    ctx.fillStyle = css('--truth');
    for (const e of g.events) ctx.fillText(e.real ? '▲' : '✕', X(e.t) - 4, pad.top + 8);
  }

  if (advanced) {
    polyline([[0, Y(TAKEOFF.humanLevel)], [W, Y(TAKEOFF.humanLevel)]], css('--muted'), 1, [1, 4]);
    ctx.fillStyle = css('--muted');
    ctx.fillText('human level', W - 80, Y(TAKEOFF.humanLevel) - 4);
  }

  // Advanced: latent (dashed) and internal (thin) capability; yours while live, both revealed after.
  if (advanced) {
    for (const i of isLive(g) ? [0] : [1, 0]) {
      const color = i ? css('--them') : css('--you');
      polyline(hist.map((h) => [X(h.t), Y(h.latent[i])]), color, 1.5, [4, 3]);
      polyline(hist.map((h) => [X(h.t), Y(h.internal[i])]), color, 1.5);
    }
  }

  for (const i of [1, 0]) polyline(hist.map((h) => [X(h.t), Y(h.deployed[i])]), i ? css('--them') : css('--you'), i ? 2.5 : 3);

  if (isLive(g)) {
    const me = g.labs[0];
    const research = [[g.t, me.deployed], ...me.deployments.map((d) => [d.at, me.externalFraction * me.internalFraction * d.position])];
    polyline(research.map(([t, v]) => [X(t), Y(v)]), css('--you'), 3, [1, 6]);
    for (const i of [1, 0]) {
      ctx.beginPath();
      ctx.arc(X(g.t), Y(g.labs[i].deployed), 5, 0, 2 * Math.PI);
      ctx.fillStyle = css('--bg');
      ctx.fill();
      ctx.strokeStyle = i ? css('--them') : css('--you');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// ---- input + loop ----

function press() {
  if (!isLive(game) && $('#result').hidden) {
    $('#result').hidden = false;
    return;
  }
  if (game.phase !== 'running') return;
  started = true;
  held = !advanced;
}

function release() {
  held = false;
}

const pedal = $('#accelerator');
pedal.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || pedal.disabled) return;
  e.preventDefault();
  pedal.setPointerCapture(e.pointerId);
  press();
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pedal.addEventListener(ev, release);
pedal.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  if (!e.repeat) press();
});
addEventListener('keyup', (e) => e.code === 'Space' && release());
addEventListener('blur', release);
$('#again').addEventListener('click', () => start(newSeed()));
$('#close-result').addEventListener('click', () => {
  $('#result').hidden = true;
});

// Keyboard: Q/A capability share, W/S internal, E/D external, in steps of 10%.
const KEYS = {
  KeyQ: ['#research', 10], KeyA: ['#research', -10], KeyW: ['#internal', 10],
  KeyS: ['#internal', -10], KeyE: ['#external', 10], KeyD: ['#external', -10],
};
addEventListener('keydown', (e) => {
  if (!advanced || !(e.code in KEYS) || e.target.matches('input')) return;
  e.preventDefault();
  const [sel, delta] = KEYS[e.code];
  $(sel).value = Number($(sel).value) + delta;
});

const modeLink = $('#mode-link');
const other = new URLSearchParams(params);
if (advanced) other.delete('mode');
else other.set('mode', 'advanced');
modeLink.href = `?${other}`;
modeLink.textContent = advanced ? 'Switch to classic mode' : 'Try advanced mode';

let last = null;
let pending = 0;
function frame(now) {
  if (last !== null && started && isLive(game)) {
    pending += Math.min(0.1, (now - last) / 1000) * Number($('#game-speed').value);
    while (pending >= SIM.dt && isLive(game)) {
      tick(game, advanced ? controls() : held);
      pending -= SIM.dt;
    }
    if (!isLive(game)) {
      held = false;
      showResult();
    }
  }
  last = now;
  renderPanels();
  drawChart();
  requestAnimationFrame(frame);
}

start(params.has('seed') ? mixSeed(Number(params.get('seed'))) : newSeed());
requestAnimationFrame(frame);
