import { createOfficeServer } from './bridge.mjs';
import { defaultDataDir } from './settings.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = 4780;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = defaultDataDir();
let server;
try {
  server = createOfficeServer({ dataDir, staticDir: join(root, 'dist'),
    service: 'agent-office', instanceId: process.env.AGENT_OFFICE_INSTANCE_ID });
} catch {
  console.error('Agent Office 기록 저장소를 열지 못했습니다. 저장 경로와 접근 권한을 확인해 주세요.');
  process.exit(1);
}

server.on('error', (error) => {
  const message = error.code === 'EADDRINUSE'
    ? `포트 ${port}을 이미 사용 중입니다. 기존 Agent Office bridge를 확인해 주세요.`
    : 'Agent Office bridge를 시작하지 못했습니다.';
  console.error(message);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Agent Office bridge: http://127.0.0.1:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    process.exitCode = 0;
  });
  server.closeIdleConnections();
  const timeout = setTimeout(() => server.closeAllConnections(), 3_000);
  timeout.unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
