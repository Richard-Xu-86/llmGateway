// Runs every service in one terminal with no extra dependency.
import { spawn } from 'node:child_process';

const services = [
  { name: 'mock     ', color: '\x1b[35m', cmd: ['tsx', 'watch', 'packages/mock-openai/src/server.ts'] },
  { name: 'backend  ', color: '\x1b[33m', cmd: ['tsx', 'watch', 'packages/backend/src/server.ts'] },
  { name: 'gateway  ', color: '\x1b[36m', cmd: ['tsx', 'watch', 'packages/gateway/src/server.ts'] },
  { name: 'dashboard', color: '\x1b[32m', cmd: ['vite', '--config', 'packages/dashboard/vite.config.ts', 'packages/dashboard'] },
];

const children = services.map(({ name, color, cmd }) => {
  const child = spawn('npx', cmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The gateway ships logs to the backend rather than keeping them in memory
    // once the backend is part of the picture.
    env: { ...process.env, LOG_SINK: process.env.LOG_SINK ?? 'http' },
  });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
});

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setTimeout(() => {
  console.log('\n\x1b[1m  dashboard → http://localhost:5173\x1b[0m');
  console.log('  gateway   → http://localhost:4000   (demo key: gw_live_demo_key_1)\n');
}, 2500);
