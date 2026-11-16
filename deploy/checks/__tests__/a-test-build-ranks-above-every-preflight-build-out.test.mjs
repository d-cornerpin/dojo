// A test build's number ranks above the latest stable and above every preflight build already published: with
// no base it continues the newest preflight line, and a base that would rank below what is out is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseScratch } from './release-scratch.mjs';

const OUT = { branch: 'Preflight', stable: '3.4.1', released: ['v3.5.0-preflight.3', 'v3.5.0-preflight.2', 'v3.4.1-preflight.9'] };

test('with no base the number continues the newest preflight line', () => {
  const box = releaseScratch(OUT);
  try {
    const r = box.run(['--preflight', '--dry-run']);
    assert.match(r.stdout, /✓ 3\.5\.0-preflight\.4 ranks above current stable 3\.4\.1 and newest preflight v3\.5\.0-preflight\.3/, r.stdout + r.stderr);
  } finally { box.clean(); }
});

test('a base that would rank below a preflight already out is refused', () => {
  const box = releaseScratch(OUT);
  try {
    const r = box.run(['3.4.2', '--preflight', '--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /3\.4\.2-preflight\.1 does NOT rank above everything already out/);
  } finally { box.clean(); }
});

test('a release list that cannot be read is refused, never taken as no preflight out', () => {
  const box = releaseScratch({ ...OUT, listFails: true });
  try {
    const r = box.run(['--preflight', '--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Could not read the release list/);
    assert.doesNotMatch(r.stdout, /ranks above/);
  } finally { box.clean(); }
});
