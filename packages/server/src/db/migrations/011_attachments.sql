-- Add attachments column to messages table
-- JSON array of { fileId, filename, mimeType, size, path }
ALTER TABLE messages ADD COLUMN attachments TEXT;
