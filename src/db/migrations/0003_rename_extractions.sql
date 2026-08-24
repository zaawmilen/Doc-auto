DO $$
BEGIN
  IF to_regclass('public.extractions') IS NOT NULL
    AND to_regclass('public.documents_extraction') IS NULL THEN
    ALTER TABLE "extractions" RENAME TO "documents_extraction";
  END IF;
END $$;