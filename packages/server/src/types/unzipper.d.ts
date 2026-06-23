// Minimal ambient types for `unzipper` (no @types package ships for it).
// Only the seek-based Open.file API we use for streaming large-zip reads is
// declared — unzipper.Open.file reads the central directory via fd seeks and
// streams each entry, so it handles multi-GB archives that adm-zip cannot.
declare module 'unzipper' {
  import type { Readable } from 'node:stream';

  interface UnzipperFile {
    path: string;
    type: 'File' | 'Directory';
    uncompressedSize: number;
    stream(): Readable;
    buffer(): Promise<Buffer>;
  }

  interface CentralDirectory {
    files: UnzipperFile[];
  }

  export const Open: {
    file(path: string): Promise<CentralDirectory>;
  };
}
