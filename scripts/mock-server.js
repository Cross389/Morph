'use strict';
// 独立运行假 AI 接口：node scripts/mock-server.js 8787
const mock = require('../electron/dev/mock-ai');
const port = Number(process.argv[2] || 8787);
mock.start(port).then(({ port: p }) => {
  console.log('MOCK_AI_LISTENING:' + p);
});