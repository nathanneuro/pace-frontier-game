import {
  SIM, DEPLOY_LAG, UNCERTAINTY, createGame, tick, isLive, bandCenter, frontierCapability,
  expectedMonthlyRisk, monthlyRisk, cumulativeRisk, monthsRemaining, gameDate,
} from './sim.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const halfWidth = params.has('w') ? Number(params.get('w')) : UNCERTAINTY.halfWidth;
if (!(Number.isFinite(halfWidth) && halfWidth >= 0)) throw Error(`Invalid ?w=${params.get('w')}; expected a non-negative number.`);

const RISK_LEVELS = [['critical', 0.025], ['warning', 0.004], ['watch', 0.001]].map(([k, rate]) => [k, monthlyRisk(rate)]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WINDOW = 12;

let game;
let held = false;
let seed;

function newSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function start(s) {
  seed = s;
  game = createGame(seed, { halfWidth });
  $('#result').hidden = true;
  $('#accelerator').disabled = false;
}

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
  const d = gameDate(g.t);
  $('#date').textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  const risk = expectedMonthlyRisk(g);
  $('#risk-value').textContent = `${(100 * risk).toFixed(2)}%`;
  $('#risk-card').dataset.level = RISK_LEVELS.find(([, r]) => risk >= r)?.[0] ?? 'quiet';
  const c = frontierCapability(g);
  const center = bandCenter(g);
  $('#risk-zone').textContent =
    c <= center - g.halfWidth ? 'Frontier model below danger zone'
      : c >= center + g.halfWidth ? 'Frontier model above danger zone'
        : 'Frontier model in danger zone';

  $('#accelerator').setAttribute('aria-pressed', String(held && g.phase === 'running'));
}

function showResult() {
  const g = game;
  $('#accelerator').disabled = true;
  $('#result-title').textContent = g.reason === 'catastrophe' ? 'Catastrophe' : 'Complete';
  $('#result-scores').textContent = `You ${money(g.scores[0])} · Competitor ${money(g.scores[1])}`;
  $('#result-risk').textContent = `Realized cumulative catastrophe risk: ${(100 * cumulativeRisk(g)).toFixed(2)}%`;
  const b = g.bias;
  $('#result-frontier').textContent = g.halfWidth === 0
    ? 'The frontier was shown exactly this game (w=0).'
    : `The true frontier was ${Math.abs(b).toFixed(2)} ${b > 0 ? 'below' : 'above'} the center of the danger zone (zone half-width ${g.halfWidth}).`;
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
  if (live) highs.push(g.labs[0].position);
  else highs.push(...visible.map((h) => h.safety));
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
  const Y = (v) => H - pad.bottom - ((v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);
  const hist = [...g.history];
  if (hist.at(-1).t < g.t) hist.push({ t: g.t, safety: g.safety, center: bandCenter(g), deployed: g.labs.map((l) => l.deployed) });

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ui-monospace, Menlo, monospace';

  if (isLive(g)) {
    ctx.fillStyle = css('--future');
    ctx.fillRect(X(g.t), 0, W - X(g.t), H);
  }

  const step = 4 * 2 ** Math.max(0, Math.ceil(Math.log2((hi - lo) / 6 / 4)));
  ctx.strokeStyle = css('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    ctx.moveTo(0, Y(v));
    ctx.lineTo(W, Y(v));
  }
  ctx.stroke();

  // Month ticks on the x axis.
  ctx.fillStyle = css('--muted');
  let lastRight = -Infinity;
  for (let m = 0; ; m++) {
    const d = new Date(Date.UTC(2026, 7 + m, 1));
    const t = (d - gameDate(0)) / 864e5 / 7;
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

  if (!isLive(g)) polyline(hist.map((h) => [X(h.t), Y(h.safety)]), css('--truth'), 2, [6, 5]);

  for (const i of [1, 0]) polyline(hist.map((h) => [X(h.t), Y(h.deployed[i])]), i ? css('--them') : css('--you'), i ? 2.5 : 3);

  if (isLive(g)) {
    const me = g.labs[0];
    const research = [[g.t, me.deployed], ...me.deployments.map((d) => [d.at, d.position])];
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

function setHeld(v) {
  held = v && game.phase === 'running';
}

const pedal = $('#accelerator');
pedal.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || pedal.disabled) return;
  e.preventDefault();
  pedal.setPointerCapture(e.pointerId);
  setHeld(true);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pedal.addEventListener(ev, () => setHeld(false));
pedal.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  if (!e.repeat) setHeld(true);
});
addEventListener('keyup', (e) => e.code === 'Space' && setHeld(false));
addEventListener('blur', () => setHeld(false));
$('#again').addEventListener('click', () => start(newSeed()));

let last = null;
let pending = 0;
function frame(now) {
  if (last !== null && isLive(game)) {
    pending += Math.min(0.1, (now - last) / 1000);
    while (pending >= SIM.dt && isLive(game)) {
      tick(game, held);
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

start(params.has('seed') ? Number(params.get('seed')) >>> 0 : newSeed());
requestAnimationFrame(frame);
