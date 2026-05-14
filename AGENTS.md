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

## Cross-repo coordination

Contract changes (response shape, `errorCode` rename, socket event payload) require coordinated PRs in `orbitx-admin-frontend/` and `OrbitMobile/`. There is no codegen — drift is silent.

## If the linked context file is missing

If `../_bmad-output/project-context.md` is unreachable (e.g., this repo was cloned standalone), ask the user for the file or regenerate it via the BMad `bmad-generate-project-context` skill from the parent workspace.
