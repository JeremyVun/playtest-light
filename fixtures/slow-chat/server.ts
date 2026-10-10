import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export async function startSlowChat(delayMs = 20_000) {
  let submissions = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Slow chat</title>
<main><h1>Slow chat</h1><p>Responses take about ${delayMs / 1000} seconds. Send becomes enabled when the response is complete.</p>
<form><label>Message <input name="message" required></label><button>Send</button></form>
<p role="status" aria-label="Generating" hidden>Generating response…</p><article aria-label="Response"></article></main>
<script>
const form=document.querySelector('form'),send=document.querySelector('button'),status=document.querySelector('[role=status]'),answer=document.querySelector('article');
form.addEventListener('submit',async event=>{
 event.preventDefault();if(send.disabled)return;send.disabled=true;status.hidden=false;answer.textContent='';
 try{const response=await fetch('/reply',{method:'POST',body:new FormData(form).get('message')});
 const reader=response.body.getReader(),decoder=new TextDecoder();
 for(;;){const {done,value}=await reader.read();if(done)break;answer.textContent+=decoder.decode(value,{stream:true});}
 }catch(error){answer.textContent='Response failed: '+error.message;}
 finally{status.hidden=true;send.disabled=false;}
});
</script></html>`;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/reply' && req.method === 'POST') {
      submissions++;
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
      res.write('Working on your request. ');
      const timer = setTimeout(() => { timers.delete(timer); res.end('Your request is complete.'); }, delayMs);
      timers.add(timer);
      res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
    } else {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
      res.end(req.url === '/other' ? '<h1>Another page</h1>' : html);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No chat server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    get submissions() { return submissions; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seconds = Number(process.argv[2] ?? 20);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('Pass a delay in seconds, up to 86400.');
  const app = await startSlowChat(seconds * 1000);
  console.log(`Slow chat: ${app.url} (${seconds}s responses)`);
  process.once('SIGINT', () => { void app.close(); });
  process.once('SIGTERM', () => { void app.close(); });
}
