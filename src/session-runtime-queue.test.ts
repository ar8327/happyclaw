import assert from 'node:assert/strict';

import { SessionRuntimeQueue } from './session-runtime-queue.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for runtime invocation');
}

type QueueInternals = {
  runForGroup: (
    groupJid: string,
    reason: 'messages' | 'drain',
  ) => Promise<void>;
  runTask: (
    groupJid: string,
    task: { id: string; groupJid: string; fn: () => Promise<void> },
  ) => Promise<void>;
};

async function verifyMessageRuntimeGenerationGuard(): Promise<void> {
  const queue = new SessionRuntimeQueue();
  const internals = queue as unknown as QueueInternals;
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  let calls = 0;

  queue.setProcessMessagesFn(async () => {
    calls++;
    return calls === 1 ? first.promise : second.promise;
  });

  const firstRun = internals.runForGroup('web:generation', 'messages');
  await waitFor(() => calls === 1);
  const secondRun = internals.runForGroup('web:generation', 'messages');
  await waitFor(() => calls === 2);

  first.resolve(true);
  await firstRun;

  let status = queue.getStatus();
  assert.equal(status.activeCount, 1);
  assert.equal(status.groups[0]?.active, true);
  assert.equal(status.groups[0]?.groupFolder, 'web:generation');

  second.resolve(true);
  await secondRun;

  status = queue.getStatus();
  assert.equal(status.activeCount, 0);
  assert.equal(status.groups[0]?.active, false);
  assert.equal(status.groups[0]?.groupFolder, null);
}

async function verifyQueuedTaskGenerationGuard(): Promise<void> {
  const queue = new SessionRuntimeQueue();
  const internals = queue as unknown as QueueInternals;
  const first = deferred<void>();
  const second = deferred<void>();

  const firstRun = internals.runTask('web:generation', {
    id: 'first',
    groupJid: 'web:generation',
    fn: () => first.promise,
  });
  const secondRun = internals.runTask('web:generation', {
    id: 'second',
    groupJid: 'web:generation',
    fn: () => second.promise,
  });

  first.resolve();
  await firstRun;

  let status = queue.getStatus();
  assert.equal(status.activeCount, 1);
  assert.equal(status.groups[0]?.active, true);
  assert.equal(status.groups[0]?.groupFolder, 'web:generation');

  second.resolve();
  await secondRun;

  status = queue.getStatus();
  assert.equal(status.activeCount, 0);
  assert.equal(status.groups[0]?.active, false);
  assert.equal(status.groups[0]?.groupFolder, null);
}

async function verifyWaitingRuntimeSerialization(
  kind: 'message' | 'task',
): Promise<void> {
  const queue = new SessionRuntimeQueue();
  const first = deferred<boolean>();
  const next = deferred<boolean>();
  let calls = 0;
  let queuedTaskCalls = 0;
  queue.setProcessMessagesFn(async (jid) => {
    if (jid === 'web:other') return true;
    calls++;
    return calls === 1 ? first.promise : next.promise;
  });

  queue.enqueueMessageCheck('web:active');
  if (kind === 'message') {
    queue.enqueueMessageCheck('web:active');
  } else {
    queue.enqueueTask('web:active', 'queued', async () => {
      queuedTaskCalls++;
      await next.promise;
    });
  }
  // Completion in another Session drains the global waiting set. The active
  // Session must retain its writer until its original invocation exits.
  queue.enqueueMessageCheck('web:other');
  await waitFor(
    () => !queue.getStatus().groups.find((g) => g.jid === 'web:other')?.active,
  );
  const callsBeforeExit = calls;
  const tasksBeforeExit = queuedTaskCalls;
  const activeBeforeExit = queue.getStatus().activeCount;
  first.resolve(true);
  await waitFor(() =>
    kind === 'message' ? calls === 2 : queuedTaskCalls === 1,
  );
  next.resolve(true);
  await waitFor(() => queue.getStatus().activeCount === 0);

  assert.equal(
    callsBeforeExit,
    1,
    'waiting drain must not start a second writer',
  );
  assert.equal(
    tasksBeforeExit,
    0,
    'queued task must wait for the active writer',
  );
  assert.equal(activeBeforeExit, 1);
}

async function verifyExitListenerSerialization(): Promise<void> {
  const queue = new SessionRuntimeQueue();
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const third = deferred<boolean>();
  let calls = 0;
  queue.setProcessMessagesFn(() => [first, second, third][calls++]!.promise);
  queue.addOnContainerExitListener((jid) => {
    if (calls !== 1) return;
    queue.enqueueMessageCheck(jid);
    queue.enqueueMessageCheck(jid);
  });
  queue.enqueueMessageCheck('web:listener');
  first.resolve(true);
  await waitFor(() => calls >= 2);
  const callsBeforeSecondExit = calls;
  second.resolve(true);
  await waitFor(() => calls === 3);
  third.resolve(true);
  await waitFor(() => queue.getStatus().activeCount === 0);
  assert.equal(
    callsBeforeSecondExit,
    2,
    'exit listener handoff must retain serialization',
  );
}

await verifyExitListenerSerialization();
await verifyWaitingRuntimeSerialization('message');
await verifyWaitingRuntimeSerialization('task');
await verifyMessageRuntimeGenerationGuard();
await verifyQueuedTaskGenerationGuard();

console.log('session runtime queue generation guard tests passed');
