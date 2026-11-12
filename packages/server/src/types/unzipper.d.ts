// Minimal ambient types for unzipper (no @types package ships for it).
// Only the seek-based Open.file API is declared: it streams entries, so multi-GB zips work.
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
