-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('DRAFT', 'JD_GENERATED', 'APPROVED');

-- CreateEnum
CREATE TYPE "jd_source" AS ENUM ('AI', 'HR_EDIT');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "form_data" JSONB NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'DRAFT',
    "current_jd_version_id" UUID,
    "openings" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jd_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "jd_source" NOT NULL,
    "content" JSONB NOT NULL,
    "company_snapshot" JSONB,
    "prompt_version" TEXT,
    "model" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jd_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "jd_version_id" UUID NOT NULL,
    "approved_by" TEXT NOT NULL,
    "company_details_verified" BOOLEAN NOT NULL,
    "note" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "products_services" TEXT,
    "website" TEXT,
    "headquarters" TEXT,
    "company_size" TEXT,
    "founded_year" INTEGER,
    "culture" TEXT,
    "benefits" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_tenant_id_created_at_idx" ON "jobs"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jd_versions_job_id_version_key" ON "jd_versions"("job_id", "version");

-- CreateIndex
CREATE INDEX "job_approvals_job_id_idx" ON "job_approvals"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "company_profiles_tenant_id_key" ON "company_profiles"("tenant_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jd_versions" ADD CONSTRAINT "jd_versions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_approvals" ADD CONSTRAINT "job_approvals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_approvals" ADD CONSTRAINT "job_approvals_jd_version_id_fkey" FOREIGN KEY ("jd_version_id") REFERENCES "jd_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
