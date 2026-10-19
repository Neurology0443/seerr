import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = path.resolve(__dirname, '../..');
const runner = path.join(repositoryRoot, 'server/test/index.mts');

const fixtures = [
  {
    name: 'successful assertions',
    extension: 'cjs',
    source: `
      const { test } = require('node:test');
      const assert = require('node:assert/strict');
      test('runner fixture', () => assert.equal(1, 1));
    `,
    succeeds: true,
    output: /runner fixture/,
  },
  {
    name: 'failed assertions',
    extension: 'cjs',
    source: `
      const { test } = require('node:test');
      const assert = require('node:assert/strict');
      test('runner fixture', () => assert.equal(1, 2, 'assertion sentinel'));
    `,
    succeeds: false,
    output: /assertion sentinel/,
  },
  {
    name: 'test-file compilation failures',
    extension: 'ts',
    source: `export const value: number = 'compilation sentinel';`,
    succeeds: false,
    output: /TS2322/,
  },
  {
    name: 'failed hooks',
    extension: 'cjs',
    source: `
      const { before, test } = require('node:test');
      before(() => { throw new Error('hook sentinel'); });
      test('runner fixture', () => {});
    `,
    succeeds: false,
    output: /hook sentinel/,
  },
];

describe('test runner CLI exit status (DT-002)', () => {
  for (const explicitReporters of [false, true]) {
    for (const fixture of fixtures) {
      it(`${fixture.name} with ${explicitReporters ? 'explicit spec/TAP reporters' : 'the default reporter'}`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'seerr-runner-'));
        try {
          const fixturePath = path.join(
            directory,
            `fixture.${fixture.extension}`
          );
          const reportPath = path.join(directory, 'report.tap');
          await writeFile(fixturePath, fixture.source);

          // Nested runs must not overwrite the outer CI JUnit report or use
          // application configuration. All fixture files/logs are temporary.
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '',
            CONFIG_DIRECTORY: directory,
            NODE_DISABLE_COLORS: '1',
          };
          // This is a fresh CLI invocation, not a child of the outer node:test
          // harness. Inheriting this marker makes run() skip every fixture.
          delete env.NODE_TEST_CONTEXT;
          for (const key of Object.keys(env)) {
            if (key.startsWith('DB_')) delete env[key];
          }

          const result = spawnSync(
            process.execPath,
            [
              runner,
              fixturePath,
              ...(explicitReporters
                ? [
                    '--test-reporter',
                    'spec',
                    '--test-reporter-destination',
                    'stderr',
                    '--test-reporter',
                    'tap',
                    '--test-reporter-destination',
                    reportPath,
                  ]
                : []),
            ],
            {
              cwd: repositoryRoot,
              env,
              encoding: 'utf8',
              timeout: 30_000,
            }
          );
          const output = result.stdout + result.stderr;
          assert.ifError(result.error);
          assert.equal(result.signal, null, output);
          assert.notEqual(result.status, null, output);
          assert.match(output, fixture.output);
          if (fixture.succeeds) {
            assert.equal(result.status, 0, output);
          } else {
            assert.notEqual(result.status, 0, output);
          }

          if (explicitReporters) {
            assert.equal(result.stdout, '');
            assert.match(result.stderr, /ℹ tests/);
            const report = await readFile(reportPath, 'utf8');
            assert.match(report, /TAP version 13/);
            assert.match(
              report,
              new RegExp(`# fail ${fixture.succeeds ? 0 : 1}`)
            );
          } else {
            assert.match(result.stdout, /ℹ tests/);
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
