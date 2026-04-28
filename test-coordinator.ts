/**
 * Prueba Rápida de MCPCoordinator con OpenRouter
 * Ejecutar: npx ts-node test-coordinator.ts
 */

import { MCPCoordinator } from './src/coordinator/MCPCoordinator'

async function testCoordinator() {
  const coordinator = new MCPCoordinator()

  // Prueba 1: Query simple → Debería elegir Ollama local
  console.log('\n=== TEST 1: Query Simple ===')
  const decision1 = await coordinator.selectStrategy('list my files', {
    userInput: 'list my files',
    conversationLength: 1,
    availableTools: 40,
    resourcesAvailable: {
      ollama: true,
      openrouter: true,
      mcp: false,
      anthropic: true,
    },
  })
  console.log('Decision:', decision1)
  console.log(`✓ Esperado: local-ollama, Obtenido: ${decision1.strategy}`)

  // Prueba 2: Query moderada → Debería elegir OpenRouter
  console.log('\n=== TEST 2: Query Moderada (Análisis) ===')
  const decision2 = await coordinator.selectStrategy(
    'analyze this code and suggest optimizations for performance',
    {
      userInput: 'analyze this code and suggest optimizations',
      conversationLength: 1,
      availableTools: 40,
      resourcesAvailable: {
        ollama: true,
        openrouter: true,
        mcp: false,
        anthropic: true,
      },
    }
  )
  console.log('Decision:', decision2)
  console.log(`✓ Esperado: openrouter-free, Obtenido: ${decision2.strategy}`)

  // Prueba 3: Query compleja → Debería elegir MCP
  console.log('\n=== TEST 3: Query Compleja (Multi-tool) ===')
  const decision3 = await coordinator.selectStrategy(
    'push my changes to github, create pull request, and send slack notification',
    {
      userInput: 'push changes to github and slack',
      conversationLength: 1,
      availableTools: 40,
      resourcesAvailable: {
        ollama: true,
        openrouter: true,
        mcp: true,
        anthropic: true,
      },
    }
  )
  console.log('Decision:', decision3)
  console.log(`✓ Esperado: mcp-superassistant, Obtenido: ${decision3.strategy}`)

  // Prueba 4: Solo Anthropic disponible
  console.log('\n=== TEST 4: Fallback a Anthropic ===')
  const decision4 = await coordinator.selectStrategy('debug this error', {
    userInput: 'debug this error',
    conversationLength: 1,
    availableTools: 40,
    resourcesAvailable: {
      ollama: false,
      openrouter: false,
      mcp: false,
      anthropic: true,
    },
  })
  console.log('Decision:', decision4)
  console.log(`✓ Esperado: anthropic-fallback, Obtenido: ${decision4.strategy}`)

  console.log('\n✅ TODAS LAS PRUEBAS COMPLETADAS')
}

testCoordinator().catch(console.error)
