# Prisma (shared database schema)

- One `.prisma` file per area inside `schema/` (owner writes only their own file).
- Every tenant-owned table needs `tenant_id` (doc section 11 / M33). IDs: UUIDv7.
- **Migrations are a conflict hotspot.** Rule: announce in the team chat before running
  `prisma migrate dev`. If two migrations collide after a pull: delete YOUR migration folder,
  `git pull --rebase`, then re-run `prisma migrate dev` to regenerate it.
