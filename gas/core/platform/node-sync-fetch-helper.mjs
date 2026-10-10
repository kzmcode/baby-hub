// 同期 HTTP のためのヘルパ。stdin に {url, method, headers, body} (JSON) を受け取り、
// stdout に {status, body} (JSON) を出力する。node.ts から execFileSync で起動される。
import { stdin, stdout } from 'node:process';

let input = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) input += chunk;

try {
  const req = JSON.parse(input);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const body = await res.text();
  stdout.write(JSON.stringify({ status: res.status, body, headers: Object.fromEntries(res.headers.entries()) }));
} catch (e) {
  stdout.write(JSON.stringify({ status: 0, body: '', error: String(e && e.message ? e.message : e) }));
}
