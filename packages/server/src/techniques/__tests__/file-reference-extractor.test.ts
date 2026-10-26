// The file-reference extractor and the dependency manifest reader/writer had no
// test of their own. The extractor decides which paths in a technique's text
// are checked against the technique folder: skip a real reference and a
// technique is accepted with a missing file; invent a phantom one and it is
// refused for a file it never names. These cases pin the extractor's shapes
// and the manifest round-trip, all measured on v35.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractFileReferences,
  readDependencyManifest,
  writeDependencyManifest,
  emptyDependencyManifest,
} from '../dependencies.js';

// `source:raw` keeps the two halves a reader would otherwise fold together —
// the same path found in a link and in inline code is a distinct reference.
const raws = (md: string): string[] =>
  extractFileReferences(md).map((r) => `${r.source}:${r.raw}`);

describe('extractFileReferences — the shapes a technique uses to name a file', () => {
  it('a markdown link and an inline-code path, each read once', () => {
    expect(raws('See [guide](docs/guide.md) and `./bin/tool.py`.'))
      .toEqual(['markdown_link:docs/guide.md', 'inline_code:./bin/tool.py']);
  });

  it('URLs, mailto links, and bare commands / bare names in code are ignored', () => {
    // A link whose target is a URL or mailto is not a file; `npm install`,
    // `run.sh` and `ls -la` are argv, not path declarations.
    expect(raws('[site](https://x.example/a.md) [mail](mailto:a@b.co) `npm install` `run.sh` `ls -la`'))
      .toEqual([]);
  });

  it('version numbers and fenced code are ignored', () => {
    // `1.2.3` / `v2.0.1` are versions, not paths; `node build.js` lives inside
    // a fence, whose body the extractor deliberately does not scan.
    expect(raws('Needs `1.2.3` and `v2.0.1`.\n```bash\nnode build.js\n```\n'))
      .toEqual([]);
  });

  it('a reference is counted once per source kind', () => {
    expect(raws('[a](x/y.md) [b](x/y.md) `./x/y.md` `./x/y.md`'))
      .toEqual(['markdown_link:x/y.md', 'inline_code:./x/y.md']);
  });

  it('surrounding quotes and trailing prose punctuation are stripped', () => {
    expect(raws('`"./a/b.txt"` `./c/d.txt.` `./e/f.txt;`'))
      .toEqual(['inline_code:./a/b.txt', 'inline_code:./c/d.txt', 'inline_code:./e/f.txt']);
  });
});

describe('the dependency manifest reader / writer', () => {
  it('a folder with no dependencies.json reads as the empty manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-deps-'));
    expect(readDependencyManifest(dir)).toEqual(emptyDependencyManifest());
  });

  it('a file that is not JSON reads as the empty manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-deps-'));
    fs.writeFileSync(path.join(dir, 'dependencies.json'), '{not json', 'utf-8');
    expect(readDependencyManifest(dir)).toEqual(emptyDependencyManifest());
  });

  it('a written manifest reads back unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-deps-'));
    const manifest = { ...emptyDependencyManifest(), manual_steps: ['unlock the door'] };
    writeDependencyManifest(dir, manifest);
    expect(readDependencyManifest(dir)).toEqual(manifest);
  });

  it('a non-array section is read back as an empty array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-deps-'));
    fs.writeFileSync(path.join(dir, 'dependencies.json'), '{"repos":"nope","manual_steps":["x"]}', 'utf-8');
    expect(readDependencyManifest(dir)).toEqual({ ...emptyDependencyManifest(), manual_steps: ['x'] });
  });
});
