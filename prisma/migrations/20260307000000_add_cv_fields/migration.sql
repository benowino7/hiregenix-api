-- AlterTable
ALTER TABLE "JobSeeker" ADD COLUMN "summary" TEXT;
ALTER TABLE "JobSeeker" ADD COLUMN "languages" JSONB;
ALTER TABLE "JobSeeker" ADD COLUMN "awards" JSONB;
ALTER TABLE "JobSeeker" ADD COLUMN "interests" JSONB;
