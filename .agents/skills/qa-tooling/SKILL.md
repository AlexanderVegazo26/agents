---
name: qa-tooling
description: Tool selection matrix, stack-detection heuristics, and contract-testing checklist for QA work. Load when deciding what tool/framework to use for a given test type, or when picking up an unfamiliar codebase and needing to figure out what's already in place.
---

# QA Tooling

## Stack detection (do this before picking a tool)

Never assume the stack — check for it:

- `package.json` → look at `devDependencies` for existing test runners (`jest`, `vitest`, `mocha`, `playwright`, `cypress`), and `scripts` for how tests are actually invoked (`npm test`, `npm run test:e2e`, etc.).
- `pyproject.toml` / `requirements*.txt` → `pytest`, `unittest`, `hypothesis`, `tox`.
- `*.csproj` / `.sln` → `xunit`, `nunit`, `MSTest`.
- `go.mod` → built-in `testing`, `testify`.
- CI config (`.github/workflows`, `azure-pipelines.yml`, `.gitlab-ci.yml`) → authoritative source for what actually runs in the pipeline; if a test type isn't in CI, flag that rather than assuming it's covered.
- Existing test directories/naming (`__tests__`, `*.spec.ts`, `*_test.go`) → match the established convention rather than introducing a second framework for the same test type.

If two tools could plausibly do the job, use what's already in the repo. Don't introduce a new test framework/dependency without a named reason the existing one can't do the job.

## Tool matrix (by test type)

| Test type | Typical tool | When to reach for it |
|---|---|---|
| Unit | Whatever the stack's native runner is (Jest/Vitest/pytest/xUnit/go test) | Pure logic, no I/O, fast feedback |
| API / contract | Playwright API testing, supertest, pytest + requests, Postman/Newman, Pact | Request/response shape, status codes, schema stability across versions |
| Browser E2E | Playwright (see `playwright-best-practices` / `playwright-cli` skills, if installed — see note below) | User-facing flows, multi-step journeys, visual/accessibility checks |
| Load / performance | k6, Locust, JMeter | Latency under concurrency, throughput ceilings, regression vs a baseline |
| Exploratory / low-code | mabl (see `mabl-plan-test`, `mabl-debug` skills, if installed — see note below) | Fast test authoring for less technical stakeholders, visual regression, scheduled monitoring |
| Accessibility | axe-core (via Playwright), Lighthouse | WCAG conformance as part of E2E, not a separate manual pass |
| Security | OWASP ZAP, dependency audit (`npm audit`, `pip-audit`, Dependabot/Snyk) | Input handling, auth boundaries, known-vulnerable dependencies |
| Static analysis | Language-native linter/type-checker | Always — cheapest signal, run first |

> **Environment-dependent references.** `playwright-best-practices`, `playwright-cli`, `mabl-plan-test`, and `mabl-debug` are *not* part of this project's skill set — they may be installed at the user level on a given machine. Check whether they resolve before relying on them, and never treat their absence as a reason to skip the capability; the tool matrix above already gives stack-neutral alternatives for every row. The same rule applies to any tool named here: detect what the project actually uses first (above), and if nothing is detected, ask rather than introducing a new dependency.

Match the tool to the risk being tested, not to novelty — a new framework is a new maintenance burden for the whole team, not just this task.

## Contract-testing checklist

When testing an API boundary (internal service-to-service or public):

- [ ] Schema is validated against a spec (OpenAPI/JSON Schema/protobuf), not just spot-checked by hand.
- [ ] Required vs optional fields are both exercised — a field the producer always sends can still be optional in the contract.
- [ ] Backward compatibility: does a new consumer break against the old producer, and vice versa? Additive changes (new optional field) should never break existing consumers.
- [ ] Versioning strategy is explicit (URL version, header, schema version field) and tested across at least two versions if the API supports it.
- [ ] Error responses are part of the contract too — status codes, error body shape, and rate-limit/pagination headers should be asserted, not just the happy path.
- [ ] Consumer-driven contracts (if using Pact or similar) are run against the real provider in CI, not just against a mock.

## Reporting tool choice

When you pick a tool, say which one, why (matches existing stack / matches risk / no existing option covers this), and what you didn't pick and why — same discipline as `engineering-integrity`'s epistemic-labeling: convention vs preference vs objectively required.
