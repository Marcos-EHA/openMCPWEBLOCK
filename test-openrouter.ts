/**
 * Test OpenRouter Integration
 * Propósito: Probar llamada real a OpenRouter con modelo free
 * 
 * Requerimiento: export OPENROUTER_API_KEY=sk-or-...
 * 
 * Ejecutar: npx ts-node test-openrouter.ts
 */

async function testOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY

  if (!apiKey) {
    console.error('❌ OPENROUTER_API_KEY no configurada')
    console.log(
      '\nPasos para obtener API key gratuita:'
    )
    console.log('1. Ir a https://openrouter.io')
    console.log('2. Registrarse (gratuito)')
    console.log('3. Copiar API key')
    console.log('4. Ejecutar: export OPENROUTER_API_KEY=sk-or-...')
    process.exit(1)
  }

  console.log('✓ OPENROUTER_API_KEY detectada\n')

  // Test 1: Listar modelos disponibles
  console.log('=== TEST 1: Listar Modelos Disponibles ===')
  try {
    const response = await fetch('https://openrouter.io/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaude.app',
        'X-Title': 'OpenClaude',
      },
    })

    const data = await response.json()

    if (response.ok) {
      const freeModels = (data.data || []).filter((m: any) =>
        m.pricing?.prompt?.includes('0') || m.name?.includes(':free')
      )

      console.log(`✓ Total modelos: ${data.data?.length || 0}`)
      console.log(`✓ Modelos gratuitos: ${freeModels.length}`)
      console.log('\nModelos recomendados:')
      freeModels.slice(0, 5).forEach((model: any) => {
        console.log(`  - ${model.id}`)
      })
    } else {
      console.error('❌ Error listando modelos:', data)
    }
  } catch (err) {
    console.error('❌ Error en request:', err)
  }

  // Test 2: Llamada simple al modelo
  console.log('\n=== TEST 2: Simple Completions Request ===')
  try {
    const prompt = 'list los archivos principales de un proyecto TypeScript'

    console.log(`Query: "${prompt}"\n`)

    const response = await fetch('https://openrouter.io/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaude.app',
        'X-Title': 'OpenClaude',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    })

    const data = await response.json()

    if (response.ok) {
      console.log('✓ Response exitosa')
      console.log(`Model: ${data.model}`)
      console.log(`Tokens used: ${data.usage?.total_tokens || '?'}`)
      console.log(
        `\nRespuesta (primeras 200 chars):\n${data.choices?.[0]?.message?.content?.substring(0, 200) || '?'}`
      )
    } else {
      console.error('❌ Error:', data)
    }
  } catch (err) {
    console.error('❌ Error en request:', err)
  }

  // Test 3: Con tools/functions (OpenAI format)
  console.log('\n=== TEST 3: Con Tools/Functions ===')
  try {
    const response = await fetch('https://openrouter.io/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaude.app',
        'X-Title': 'OpenClaude',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [
          {
            role: 'user',
            content: 'read file /tmp/test.txt',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Leer contenido de un archivo',
              parameters: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: 'Ruta del archivo',
                  },
                },
                required: ['path'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        max_tokens: 300,
      }),
    })

    const data = await response.json()

    if (response.ok) {
      console.log('✓ Response con tools exitosa')
      console.log(`Stop reason: ${data.choices?.[0]?.finish_reason}`)

      const toolCalls = data.choices?.[0]?.message?.tool_calls
      if (toolCalls) {
        console.log(`Tool calls invocadas: ${toolCalls.length}`)
        toolCalls.forEach((call: any, i: number) => {
          console.log(
            `  ${i + 1}. ${call.function?.name} - ${JSON.stringify(call.function?.arguments)}`
          )
        })
      } else {
        console.log(
          `Contenido: ${data.choices?.[0]?.message?.content?.substring(0, 150) || '?'}`
        )
      }
    } else {
      console.error('❌ Error:', data)
    }
  } catch (err) {
    console.error('❌ Error en request:', err)
  }

  console.log('\n✅ TESTS COMPLETADOS')
}

testOpenRouter().catch(console.error)
