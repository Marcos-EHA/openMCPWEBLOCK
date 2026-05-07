#!/usr/bin/env node

const url = 'http://localhost:3006/mcp';
const headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json,text/event-stream'
};

async function callTool(method, params = {}) {
  const id = Math.random().toString(36).slice(2);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      timeout: 60000
    });
    
    const text = await res.text();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Method: ${method}`);
    console.log(`Status: ${res.status}`);
    console.log(`${'='.repeat(50)}`);
    
    // Parse SSE format (data: {...}\n)
    const lines = text.split('\n').filter(l => l.trim());
    let dataContent = '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataContent += line.slice(6);
      }
    }
    
    if (dataContent) {
      try {
        const json = JSON.parse(dataContent);
        console.log(JSON.stringify(json, null, 2));
      } catch (e) {
        console.log('Raw response:', dataContent.substring(0, 500));
      }
    }
  } catch (err) {
    console.error(`❌ Error calling ${method}:`, err.message);
  }
}

async function main() {
  console.log('🚀 Testing MCP Proxy Connection to chrome-devtools-mcp\n');
  
  // 1. List all available tools
  console.log('📋 Step 1: Listing available tools...');
  await callTool('tools/list', {});
  
  // 2. Try to create a new browser page
  console.log('\nStep 2: Creating a new browser page...');
  await callTool('tools/call', {
    name: 'chrome-devtools-mcp.new_page',
    arguments: {
      url: 'https://example.com',
      background: false
    }
  });
  
  // 3. List current browser pages
  console.log('\nStep 3: Listing browser pages...');
  await callTool('tools/call', {
    name: 'chrome-devtools-mcp.list_pages',
    arguments: {}
  });
}

main().catch(console.error);
