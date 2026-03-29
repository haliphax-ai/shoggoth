-- Remember which document body hash was embedded to skip redundant embedding API calls.
ALTER TABLE memory_embeddings ADD COLUMN content_sha256 TEXT;
