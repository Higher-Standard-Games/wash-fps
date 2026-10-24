import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Keep arguments as an array: paths and values must never become shell code.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const child = spawn(process.execPath, [
  path.join(root, 'node_modules/vite-node/vite-node.mjs'),
  path.join(root, 'src/games/fps/cli/timedemo-fixture.ts'), '--', ...process.argv.slice(2),
], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
// Windows kill(SIGINT) terminates immediately. IPC lets the recorder release
// only its own bots and server before exiting.
process.on('SIGINT', () => { if (child.connected) child.send('cancel'); });
