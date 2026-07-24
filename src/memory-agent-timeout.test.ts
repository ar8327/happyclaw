import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { ChildProcess } from 'node:child_process';

import {
  MemoryOperationTimeoutError,
  runMemoryOperationWithTimeout,
} from './memory-agent.js';

async function assertTimeoutTerminatesAndSettles(): Promise<void> {
  const process = new EventEmitter() as ChildProcess;
  let killed = false;
  Object.assign(process, {
    pid: 2_147_483_647,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals) => {
      killed = true;
      Object.defineProperty(process, 'signalCode', {
        configurable: true,
        value: signal,
      });
      process.emit('close', null, signal);
      return true;
    },
  });

  let resolveOperation!: (value: string) => void;
  const operation = new Promise<string>((resolve) => {
    resolveOperation = resolve;
  });

  await assert.rejects(
    runMemoryOperationWithTimeout({
      timeoutMs: 10,
      killGraceMs: 10,
      settleGraceMs: 100,
      run: async (onProcess) => {
        onProcess(process);
        process.once('close', () => resolveOperation('closed'));
        return operation;
      },
    }),
    (error: unknown) =>
      error instanceof MemoryOperationTimeoutError && error.timeoutMs === 10,
  );
  assert.equal(killed, true);
}

await assertTimeoutTerminatesAndSettles();
console.log('memory timeout tests passed');
