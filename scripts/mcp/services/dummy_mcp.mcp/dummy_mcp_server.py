#!/usr/bin/env python3
"""Minimal stdio MCP service used to verify the external service contract."""

import json
import sys


def reply(request_id, result=None, error=None):
    response = {"jsonrpc": "2.0", "id": request_id}
    if error:
        response["error"] = error
    else:
        response["result"] = result
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def main():
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
        except (TypeError, ValueError):
            continue
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})
        if method == "initialize":
            reply(request_id, {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "ZeroChat Dummy MCP", "version": "1.0.0"},
                "capabilities": {"tools": {}}
            })
        elif method == "tools/list":
            reply(request_id, {"tools": [{
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
                reply(request_id, error={"code": -32601, "message": "Tool not found"})
                continue
            reply(request_id, {
                "content": [{"type": "text", "text": f"echo: {params.get('arguments', {}).get('message', '')}"}],
                "isError": False
            })


if __name__ == "__main__":
    main()
