# Contributing to Recompute

Thanks for helping turn old school devices into a classroom AI lab! Teachers, IT staff, students, and developers are all welcome.

## Ways to help
- **Try it in a classroom** and open an issue about what was confusing, slow, or broken.
- **Share measured numbers.** Run the Benchmark page (`/bench`) on a real device and post the device model, browser, and results in an issue. Please share only numbers you actually measured.
- **Improve the docs**, especially setup steps for devices or browsers we haven't covered.
- **Fix bugs or add features.** For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Development setup
You need Node.js **22.13 or newer**.

```bash
npm install
npm run hub          # starts the Hub, builds the web app, prints the LAN URLs
npm test             # unit tests (scheduler and leases, FedAvg, energy rules, ...)
npm run typecheck    # TypeScript checks
```

End-to-end checks drive headless browsers against a running Hub (install browsers once with `npx playwright install chromium`):

```bash
npx tsx scripts/e2e.ts   # several headless devices: Swarm Sort speedup, a node killed mid-job, FedAvg, Science Sweep, tutor
```

## Project layout
| Path | What it is |
|---|---|
| `hub/src/` | The Hub: HTTPS server, local CA, scheduler (leases, work stealing, spot checks), FedAvg, SQLite storage |
| `hub/test/` | Unit tests (`node --test`) |
| `web/src/node/` | The Node page that devices open to join (Teach the Swarm camera, tutor) |
| `web/src/console/` | The teacher Console |
| `web/src/workers/`, `web/src/shared/kernels.ts` | Built-in compute kernels that run in Web Workers |
| `web/src/bench/` | Benchmark page |
| `scripts/` | End-to-end checks, screenshot capture, dataset preparation |
| `data/swarmsort/` | Bundled openly licensed photos (see `docs/licenses.md`) |

## Ground rules
- **Privacy first:** no accounts, no analytics, no telemetry, no cloud calls during lessons. Student photos never leave their device.
- **No remote code:** nodes run only kernels built into the app. Don't add features that send executable code over the network.
- **Pin models:** any new model must be downloaded once by the Hub, pinned to a revision, verified by SHA-256, and listed with its license in `docs/licenses.md`.
- **Honest numbers:** the UI shows only measured values. Never add estimated speedups, energy, or CO₂ figures.
- **Keep it legible:** the Console is used on projectors. Keep type big and contrast high.

## Pull requests
1. Fork, create a branch, and make your change.
2. Run `npm run typecheck` and `npm test`.
3. Fill in the pull request template, including how you tested it.

By contributing you agree that your contribution is licensed under the MIT License, and you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
