// CloudBase MCP stdio 客户端：与 @cloudbase/cloudbase-mcp 交互。
// 用法：
//   node scripts/cloudbase-mcp.js tools                     列出工具
//   node scripts/cloudbase-mcp.js call <toolName> '<json>'    调用工具
const { spawn } = require('child_process');

const [, , mode, toolName, toolArgs] = process.argv;
if (!mode || !['tools', 'call', 'schema'].includes(mode)) {
  console.error('usage: node cloudbase-mcp.js tools | schema <tool> | call <tool> <json-args>');
  process.exit(2);
}

const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(npxBin, ['-y', '@cloudbase/cloudbase-mcp@2.31.0'], {
  env: Object.assign({}, process.env, { INTEGRATION_IDE: 'Kimi' }),
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32'
});
let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', chunk => process.stderr.write(chunk));

function send(message) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id }, message)) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); }
    }, 300000);
  });
}

async function main() {
  const init = await send({ method: 'initialize', params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'flower-tag-deploy', version: '1.0.0' }
  }});
  if (init.error) throw new Error(JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  if (mode === 'tools') {
    const list = await send({ method: 'tools/list', params: {} });
    const tools = (list.result && list.result.tools) || [];
    tools.forEach(t => console.log(t.name + '\n  ' + (t.description || '').split('\n')[0]));
    console.log('TOTAL ' + tools.length);
  } else if (mode === 'schema') {
    const list = await send({ method: 'tools/list', params: {} });
    const tools = (list.result && list.result.tools) || [];
    const target = tools.filter(t => t.name === toolName);
    console.log(JSON.stringify(target, null, 2));
  } else {
    const raw = toolArgs && toolArgs.startsWith('@')
      ? require('fs').readFileSync(toolArgs.slice(1), 'utf8') : toolArgs;
    const args = raw ? JSON.parse(raw) : {};
    const result = await send({ method: 'tools/call', params: { name: toolName, arguments: args } });
    console.log(JSON.stringify(result, null, 2));
  }
  child.kill();
  process.exit(0);
}
main().catch(error => { console.error('ERROR', error.message); child.kill(); process.exit(1); });
