-- Markdown memory index, FTS5 (BM25), optional embedding blobs.

CREATE TABLE memory_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_mtime_ms INTEGER,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  body,
  content = 'memory_documents',
  content_rowid = 'id'
);

CREATE TRIGGER memory_documents_ai AFTER INSERT ON memory_documents BEGIN
INSERT INTO memory_fts(rowid, title, body)
VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER memory_documents_ad AFTER DELETE ON memory_documents BEGIN
INSERT INTO memory_fts(memory_fts, rowid, title, body)
VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER memory_documents_au AFTER UPDATE ON memory_documents BEGIN
INSERT INTO memory_fts(memory_fts, rowid, title, body)
VALUES ('delete', old.id, old.title, old.body);
INSERT INTO memory_fts(rowid, title, body)
VALUES (new.id, new.title, new.body);
END;

CREATE TABLE memory_embeddings (
  document_id INTEGER NOT NULL REFERENCES memory_documents (id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, model_id)
);

CREATE INDEX idx_memory_embeddings_model ON memory_embeddings (model_id);
