import { createServer } from 'node:http';
import { createRehydraFetch } from '/private/tmp/claude-501/-Users-bytedance-ops/5a2992f0-ab38-4776-bf1e-a19fd1288dfb/scratchpad/rehydra-sdk/src/proxy/rehydra-fetch.ts';
import { InMemoryKeyProvider } from '/private/tmp/claude-501/-Users-bytedance-ops/5a2992f0-ab38-4776-bf1e-a19fd1288dfb/scratchpad/rehydra-sdk/src/crypto/index.ts';
import { InMemoryPIIStorageProvider } from '/private/tmp/claude-501/-Users-bytedance-ops/5a2992f0-ab38-4776-bf1e-a19fd1288dfb/scratchpad/rehydra-sdk/src/storage/in-memory.ts';

const received = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  received.push(JSON.parse(raw));
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}]}));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const rf = createRehydraFetch({ keyProvider:new InMemoryKeyProvider(), piiStorageProvider:new InMemoryPIIStorageProvider(), provider:'openai', getSessionId:async()=>'probe' });
await rf(`http://127.0.0.1:${port}/v1/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({model:'gpt-5-mini', max_tokens:10, max_completion_tokens:10, messages:[{role:'user',content:'count to 30'}]}) });
console.log('upstream received max_tokens =', received[0].max_tokens);
console.log('upstream received max_completion_tokens =', received[0].max_completion_tokens);
server.close();
