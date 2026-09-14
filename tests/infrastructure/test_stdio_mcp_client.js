const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('MCP Stdio Client - Handshake, list_tools, call_tool y gestión de ciclo de vida con servidor dummy', async () => {
  const scriptPath = path.resolve(__dirname, '../../scripts/mcp_client.py');
  const fixturePath = path.resolve(__dirname, '../fixtures/dummy_mcp_server.py');

  const pyCode = `
import sys
from scripts.mcp_client import StdioMcpClient, McpProcessManager

# 1. StdioMcpClient directo
client = StdioMcpClient(sys.executable, ['${fixturePath}'])
info = client.start()
assert info['name'] == 'Dummy MCP Server', 'Nombre de servidor incorrecto'
tools = client.list_tools()
assert len(tools) == 1, 'Debe descubrir 1 herramienta'
assert tools[0]['name'] == 'echo', 'Herramienta descubierta debe ser echo'

res = client.call_tool('echo', {'message': 'probando stdio'})
assert res['content'][0]['text'] == 'echo: probando stdio'
assert res['isError'] is False
client.stop()
assert not client.is_running(), 'El cliente debe haberse detenido'

# 2. McpProcessManager
mgr = McpProcessManager({
    'test_server': {
        'name': 'Test Server',
        'command': sys.executable,
        'args': ['${fixturePath}']
    }
})
assert mgr.get_server_status('test_server')['status'] == 'stopped'
mgr.start_server('test_server')
assert mgr.get_server_status('test_server')['status'] == 'running'
active = mgr.get_all_active_tools()
assert len(active) == 1
assert active[0]['name'] == 'mcp__test_server__echo'

call_res = mgr.call_tool('mcp__test_server__echo', {'message': 'via_router'})
assert call_res['content'][0]['text'] == 'echo: via_router'

mgr.stop_server('test_server')
assert mgr.get_server_status('test_server')['status'] == 'stopped'
print('ALL_PYTHON_STDIO_TESTS_OK')
`;

  const child = spawn('python3', ['-c', pyCode], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const exitCode = await new Promise(resolve => child.on('close', resolve));
  if (exitCode !== 0) {
    console.error('PYTHON STDIO TEST ERROR:', stderr);
  }
  assert.equal(exitCode, 0, `El test de python falló con código ${exitCode}: ${stderr}`);
  assert.ok(stdout.includes('ALL_PYTHON_STDIO_TESTS_OK'));
});

