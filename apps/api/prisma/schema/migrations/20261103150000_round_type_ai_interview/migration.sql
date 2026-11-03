-- New round type AI_INTERVIEW (rounds.prisma): a voice interview run and scored by the AI interview round module.
-- Additive: existing rows are unchanged. An API on older code fails only when it reads a round of this new type.

-- AlterEnum
ALTER TYPE "round_type" ADD VALUE 'AI_INTERVIEW';
