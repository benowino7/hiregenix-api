/*
  Warnings:

  - You are about to drop the column `industryId` on the `Company` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Company" DROP CONSTRAINT "Company_industryId_fkey";

-- DropIndex
DROP INDEX "Company_industryId_idx";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "industryId";

-- CreateTable
CREATE TABLE "CompanyIndustry" (
    "companyId" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,

    CONSTRAINT "CompanyIndustry_pkey" PRIMARY KEY ("companyId","industryId")
);

-- AddForeignKey
ALTER TABLE "CompanyIndustry" ADD CONSTRAINT "CompanyIndustry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyIndustry" ADD CONSTRAINT "CompanyIndustry_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
