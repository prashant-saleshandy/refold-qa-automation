import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Pauses the CLI and waits for the operator to press Enter, printing a message first. */
export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question(`${message}\n\nPress Enter once done...`);
  rl.close();
}
