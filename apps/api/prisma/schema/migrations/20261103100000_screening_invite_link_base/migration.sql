-- Screening link base URL per invite (ats.prisma). Additive only: a nullable column, so APIs on older code that
-- share the database keep working. Lets the API re-send a shortlist email whose link pointed at a public address
-- (e.g. a Cloudflare quick tunnel) that no longer opens.

-- AlterTable
ALTER TABLE "screening_invites" ADD COLUMN "link_base" TEXT;
