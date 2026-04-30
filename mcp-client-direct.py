#!/usr/bin/env python3
"""
Direct MCP Client - Conecta a chrome-devtools-mcp sin proxy HTTP
Ejecuta herramientas directamente via stdio
"""

import json
import subprocess
import sys
import time
from pathlib import Path

log_dir = Path(__file__).parent / "logs"
log_dir.mkdir(exist_ok=True)

output_file = log_dir / "mcp-client-direct.json"
error_file = log_dir / "mcp-client-direct-error.txt"

def send_request(process, method, params=None):
    """Send JSON-RPC request to MCP server and read response"""
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {}
    }
    
    request_json = json.dumps(request) + "\n"
    print(f"[SEND] {method}", file=sys.stderr)
    
    try:
        process.stdin.write(request_json.encode())
        process.stdin.flush()
        
        # Read response
        response_line = process.stdout.readline().decode().strip()
        if response_line:
            response = json.loads(response_line)
            print(f"[RECV] {method}: {response.get('result', response.get('error', {}))}", file=sys.stderr)
            return response
        else:
            raise Exception(f"No response for {method}")
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise

def main():
    try:
        print("Starting chrome-devtools-mcp process...", file=sys.stderr)
        
        # Launch chrome-devtools-mcp
        process = subprocess.Popen(
            ["npx", "-y", "chrome-devtools-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(Path(__file__).parent)
        )
        
        time.sleep(2)  # Wait for startup
        
        # Test: Initialize
        print("Sending initialize...", file=sys.stderr)
        init_resp = send_request(process, "initialize", {
            "protocolVersion": "2025-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mcp-client-direct", "version": "1.0.0"}
        })
        
        # Test: List tools
        print("Listing tools...", file=sys.stderr)
        list_resp = send_request(process, "tools/list", {})
        tools_count = len(list_resp.get("result", {}).get("tools", []))
        print(f"Found {tools_count} tools", file=sys.stderr)
        
        # Test: Execute new_page
        print("Executing new_page tool...", file=sys.stderr)
        tool_resp = send_request(process, "tools/call", {
            "name": "new_page",
            "arguments": {
                "url": "https://example.com",
                "background": False
            }
        })
        
        # Save results
        results = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "initialize": init_resp,
            "tools_list": list_resp,
            "new_page": tool_resp
        }
        
        with open(output_file, "w") as f:
            json.dump(results, f, indent=2)
        
        print(f"Results saved to {output_file}", file=sys.stderr)
        
        # Keep running briefly to see browser
        time.sleep(3)
        
        process.terminate()
        sys.exit(0)
        
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        with open(error_file, "w") as f:
            f.write(str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()
