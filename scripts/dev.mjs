// Runs every service in one terminal with no extra dependency.
import { spawn } from 'node:child_process';

const services = [
  { name: 'mock   ', color: '\x1b[35m', script: 'packages/mock-openai/src/server.ts' },
  { name: 'gateway', color: '\x1b[36m', script: 'packages/gateway/src/server.ts' },
];

const children = services.map(({ name, color, script }) => {
  const child = spawn('npx', ['tsx', 'watch', script], { stdio: ['ignore', 'pipe', 'pipe'] });
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
