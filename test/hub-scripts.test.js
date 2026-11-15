import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../deploy/hub/${f}`, import.meta.url), 'utf8');

test('HUB scripts are plain ASCII (Windows PowerShell 5.1)', () => {
  for (const f of ['install.ps1', 'flow-deploy.ps1']) {
    assert.ok(/^[\x00-\x7F]*$/.test(read(f)), `${f} has non-ASCII characters`);
  }
});

test('installer records tool folders and the SYSTEM deploy task reads them', () => {
  assert.match(read('install.ps1'), /tools-path\.txt/);
  const deploy = read('flow-deploy.ps1');
  assert.match(deploy, /tools-path\.txt/);
  assert.match(deploy, /WinGet\\Links/);
  // PATH must be extended before the first git/node/nssm call
  assert.ok(deploy.indexOf('tools-path.txt') < deploy.indexOf('& git'));
});
