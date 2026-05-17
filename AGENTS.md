# AGENTS.md — orbitx-backend

This is one of three independent repos that make up **OrbitX**, a Naira-denominated (Nigeria) dispatch/delivery platform. The other two (`orbitx-admin-frontend/` and `OrbitMobile/`) live side-by-side under the parent `orbit/` workspace directory.

## Read this before writing code

The canonical project context lives at: **[../_bmad-output/project-context.md](../_bmad-output/project-context.md)**

It contains 289 critical rules across 7 categories — technology stack & version pins, language-specific rules, framework conventions, testing discipline, code quality, workflow rules, and don't-miss anti-patterns. **Read it before implementing any change** in this repo.

## Repo-specific quick reference

- **Stack**: NestJS 11 (Express 5) + TypeORM 0.3.28 + PostgreSQL 15 + PostGIS, TypeScript `^5.7.3` (CJS emit, `nodenext` resolution).
- **Working branch**: `development` (PRs into `development`; merge to `main` triggers deploy).
- **Lint/build/test**: `npm run lint`, `npm run build`, `npm run test`, `npm run test:e2e`.
- **Migrations**: `npm run migration:generate <name>`, `npm run migration:run`. Forward-only after merge.
- **API**: `/api/v1/*`. Swagger at `/api/v1/docs`. Global response envelope (`{ success, message, data }`) and error envelope (`{ success: false, errorCode, message, ... }`) — do not bypass.

## Money handling (ARCH-1)

Every Naira value in this backend is a branded `decimal.js` value at runtime and a `"\d+\.\d{2}"` string on the wire. The discipline:

- **Import**: `import { naira, Naira, nairaTransformer } from '@/common/money'` (use `import type { Naira }` in entity files because of `emitDecoratorMetadata`).
- **Construct**: `naira('1000.00')` — string only. A numeric-literal call (`naira(1000)`) is blocked by the `no-restricted-syntax` lint rule in `eslint.config.mjs`. Use `naira(String(n))` if your source is a runtime number (e.g. a DTO field).
- **Arithmetic**: only `.plus`, `.minus`, `.times`, `.dividedBy` on Naira values. `Naira + number` is caught by `@typescript-eslint/restrict-plus-operands`; assigning a Naira to a `number` slot is a type error.
- **Entity columns** (decimal money): `@Column('decimal', { precision: 12, scale: 2, transformer: nairaTransformer }) field: Naira;` (or `Naira | null` for nullable columns).
- **Wire format**: any Naira inside a response object serializes as `"1500.00"` via the `Decimal.prototype.toJSON` override in `src/common/money.ts`. Explicit emitters use `nairaToJSON(value)` or `value.toFixed(2)`.
- **Forbidden**: `Number(wallet.balance)`, `parseFloat(amount)`, arithmetic via `+` or `-`, `naira(<number literal>)`.

Lat/lng and rating columns (decimal but not money) keep `numericTransformer` from `common/utils/decimal-transformer.ts` and remain typed `number`.

## Cross-repo coordination

Contract changes (response shape, `errorCode` rename, socket event payload) require coordinated PRs in `orbitx-admin-frontend/` and `OrbitMobile/`. There is no codegen — drift is silent.

## If the linked context file is missing

If `../_bmad-output/project-context.md` is unreachable (e.g., this repo was cloned standalone), ask the user for the file or regenerate it via the BMad `bmad-generate-project-context` skill from the parent workspace.
