import assert from 'node:assert/strict';

import { MemoryOrchestrator } from './memory-agent.js';

type LaneInternals = {
  runWriteSerialized<T>(ownerKey: string, task: () => Promise<T>): Promise<T>;
  runReadConcurrent<T>(ownerKey: string, task: () => Promise<T>): Promise<T>;
};

const orchestrator = new MemoryOrchestrator();
const lanes = orchestrator as unknown as LaneInternals;

let releaseWrite!: () => void;
const slowWrite = lanes.runWriteSerialized(
  'local',
  () =>
    new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }),
);
await new Promise((resolve) => setImmediate(resolve));

let readCompleted = false;
await lanes.runReadConcurrent('local', async () => {
  readCompleted = true;
});
assert.equal(readCompleted, true);
releaseWrite();
await slowWrite;

let activeReads = 0;
let maxActiveReads = 0;
let releaseReads!: () => void;
const readGate = new Promise<void>((resolve) => {
  releaseReads = resolve;
});
const reads = Array.from({ length: 4 }, () =>
  lanes.runReadConcurrent('local', async () => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await readGate;
    activeReads -= 1;
  }),
);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(maxActiveReads, 3);
releaseReads();
await Promise.all(reads);

console.log('memory lane tests passed');
