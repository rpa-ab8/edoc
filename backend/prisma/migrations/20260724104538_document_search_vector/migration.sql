-- AlterTable
ALTER TABLE "document" ADD COLUMN     "searchVector" tsvector;

-- CreateIndex
CREATE INDEX "document_searchVector_idx" ON "document" USING GIN ("searchVector");
