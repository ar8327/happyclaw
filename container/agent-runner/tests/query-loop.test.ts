import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { buildIpcPaths } from '../src/ipc-handler.js';
import { runQueryLoop } from '../src/query-loop.js';
import type { AgentRunner, QueryResult } from '../src/runner-interface.js';
import { SessionState } from '../src/session-state.js';
import {
  attachStdoutHandler,
  createStdoutParserState,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from '../../../src/agent-output-parser.js';

async function testHeartbeatForwarding(): Promise<void> {
  const stream = new PassThrough();
  const state = createStdoutParserState();
  const outputs: Array<{ status: string }> = [];
  attachStdoutHandler(stream, state, {
    groupName: 'test',
    label: 'test',
    resetTimeout: () => {},
    onOutput: async (output) => {
      outputs.push(output);
    },
  });
  stream.end(
    `${OUTPUT_START_MARKER}\n${JSON.stringify({
      status: 'heartbeat',
      result: null,
    })}\n${OUTPUT_END_MARKER}\n`,
  );
  await new Promise<void>((resolve) => stream.once('end', resolve));
  await state.outputChain;
  assert.deepEqual(outputs, [{ status: 'heartbeat', result: null }]);
}

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-query-loop-close-'),
);
const ipcPaths = buildIpcPaths(tempDir);
fs.mkdirSync(ipcPaths.inputDir, { recursive: true });
fs.writeFileSync(ipcPaths.closeSentinel, '');

let releaseQuery!: () => void;
const interrupted = new Promise<void>((resolve) => {
  releaseQuery = resolve;
});
let cleanupCalls = 0;
const outputs: Array<{ status: string }> = [];

const runner = {
  ipcCapabilities: {
    supportsMidQueryPush: true,
    supportsRuntimeModeSwitch: false,
  },
  async applyContext() {},
  async *runQuery(): AsyncGenerator<never, QueryResult> {
    await interrupted;
    return {
      closedDuringQuery: false,
      interruptedDuringQuery: false,
      drainDetectedDuringQuery: false,
    };
  },
  async interrupt() {
    releaseQuery();
  },
  async cleanup() {
    cleanupCalls += 1;
  },
  getRuntimePersistenceSnapshot() {
    return {};
  },
} as unknown as AgentRunner;

try {
  await testHeartbeatForwarding();
  await runQueryLoop({
    runner,
    state: new SessionState(),
    ipcPaths,
    initialPrompt: 'test',
    sessionRecordId: 'session:test',
    imChannelsFile: path.join(tempDir, 'recent.json'),
    buildContext: () =>
      ({
        sessionStatic: '',
        sections: [],
      }) as never,
    log: () => {},
    writeOutput: (output) => outputs.push(output),
  });

  assert.equal(cleanupCalls, 1);
  assert.equal(outputs.at(-1)?.status, 'closed');
  console.log('query loop close cleanup tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
