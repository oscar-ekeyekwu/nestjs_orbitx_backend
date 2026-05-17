# Archived prototype migrations

These migrations describe the **pre-v1 prototype schema** for OrbitX. After
ARCH-2 (Sprint 1) landed `InitialV1Migration.ts` as the consolidated v1
baseline, they are no longer run by TypeORM:

- The migrations glob in `ormconfig.ts` is non-recursive
  (`src/database/migrations/*.{ts,js}`), so files under this `_archived/`
  directory are deliberately invisible to the migration runner.
- `InitialV1Migration` itself runs `DROP TABLE IF EXISTS` for the prototype
  tables before creating the v1 schema, so a fresh DB lands directly on v1
  whether or not it carried prototype state.
- After v1 deploys to production, every subsequent migration is
  **forward-only and additive** — written on top of `InitialV1Migration`,
  never edited.

We keep these files in-tree (rather than deleting them) so the prototype
history stays auditable and the project context's "v1 consolidation"
moment is visible from `git log` alone.

## Files in this folder

| File | Purpose |
| --- | --- |
| `1760242168697-InitialMigration.ts` | First prototype schema: users, orders, notifications, driver_profiles |
| `1765037485352-CreateWalletAndConfigTables.ts` | Wallet + transactions + system_configs |
| `1765078667283-AddRefreshTokensTable.ts` | refresh_tokens |
| `1778735999000-AddIsPhoneVerifiedToUsers.ts` | users.isPhoneVerified column |
| `1779500000000-CreateSupportTickets.ts` | support_tickets |
| `1779600000000-CreateNotificationTemplates.ts` | notification_templates |

**Do not move any of these files back to the parent directory.** The
runner would then attempt to re-execute them and immediately collide
with the v1 schema.
