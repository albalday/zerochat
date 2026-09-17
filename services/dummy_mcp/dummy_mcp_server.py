#!/usr/bin/env python3
import json
import sys

def reply(req_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error:
        resp["error"] = error
    else:
        resp["result"] = result
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    try:
        req = json.loads(raw)
    except Exception:
        continue
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {})
    if method == "initialize":
        reply(req_id, {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "ZeroChat Dummy MCP", "version": "1.0.0"},
            "capabilities": {"tools": {}}
        })
    elif method == "tools/list":
        reply(req_id, {"tools": [{
            "name": "echo",
            "description": "Echo back a message for testing.",
            "inputSchema": {
                "type": "object",
                "properties": {"message": {"type": "string", "description": "Message to echo."}},
                "required": ["message"]
            }
        }]})
    elif method == "tools/call":
        if params.get("name") != "echo":
            reply(req_id, error={"code": -32601, "message": "Tool not found"})
            continue
        msg = params.get("arguments", {}).get("message", "")
        reply(req_id, {
            "content": [{"type": "text", "text": f"echo: {msg}"}],
            "isError": False
        })

