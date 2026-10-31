// Graph upload sessions: every fragment except the last must be a multiple of 320 KiB
// (327,680 bytes), per "Upload large files with an upload session" in the Graph docs.
export const ONEDRIVE_CHUNK_BYTES = 320 * 1024 * 12; // 3,932,160
