/**
 * I/O protocol helpers for AgentDock agent runners.
 *
 * Handles stdin reading, stdout marker-wrapped output, and logging.
 */

import type { ContainerOutput, StreamEvent } from './types.js';

export const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

/** Write a ContainerOutput wrapped in OUTPUT_MARKERs to stdout. */
export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/** Emit a streaming event to the host process. */
export function emitStreamEvent(event: StreamEvent): void {
  writeOutput({ status: 'stream', result: null, streamEvent: event });
}

/** Read the full stdin as a string (blocks until EOF). */
export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Create a prefixed logger that writes to stderr. */
export function createLogger(prefix: string): (message: string) => void {
  return (message: string) => {
    console.error(`[${prefix}] ${message}`);
  };
}
