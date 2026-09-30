# CLAUDE.md

Browser game replicating Paradigm's Pace with a hidden safety frontier. See README.md and
docs/original_mechanics.md.

- `src/web/sim.js` must stay DOM-free and deterministic given (seed, inputs). Keep `halfWidth=0`
  bit-identical to the original; `tests/sim.test.mjs` pins this.
- Never expose `g.safety`, any `lab.bias`, `g.hazard`, or the rival's internal/latent capability in the UI
  while the game is live. Only show the player's own zone, `expectedMonthlyRisk` (built on
  `visibleRiskCapability`), the rival's external deployment, and the post-game reveal.
- The original bundle is in `docs/reference/` (gitignored). To re-verify faithfulness, export `Be` from
  lines ~14687–15205 of `pace.pretty.js` and run it side by side with `sim.js`.
- Tests: `node --test tests/*.test.mjs`. Serve: `uv run python -m http.server 8765 -d src/web`.
