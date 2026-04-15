import { saveLocalWorkbenchProfile } from './local-user.js';

function printUsage(): void {
  console.error('Usage: npm run reset:admin -- <username>');
}

async function main(): Promise<void> {
  const username = (process.argv[2] || '').trim();
  if (!username) {
    printUsage();
    process.exit(1);
  }

  const ignoredPassword = process.argv[3];
  const user = saveLocalWorkbenchProfile({
    username,
    display_name: username,
  });

  console.log(`[OK] Updated local operator profile: ${user.username}`);
  if (ignoredPassword) {
    console.log(
      '[INFO] Single-user mode does not use an application password. Runner credentials stay in provider-specific config.',
    );
  }
}

void main();
