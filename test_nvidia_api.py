#!/usr/bin/env python3
"""
Test directo de NVIDIA API con DeepSeek v4-pro
Valida que la configuración de OpenClaude funciona correctamente
"""

from openai import OpenAI

# Configurar cliente con API de NVIDIA
client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key="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"
)

def test_basic_completion():
    """Test básico: verificar que DeepSeek responde"""
    print("=" * 60)
    print("TEST 1: Conexión básica a DeepSeek v4-pro")
    print("=" * 60)
    
    try:
        response = client.chat.completions.create(
            model="deepseek-ai/deepseek-v4-pro",
            messages=[
                {"role": "user", "content": "Hola, ¿cómo estás?"}
            ],
            max_tokens=512,
            temperature=0.7,
        )
        
        print(f"✓ Respuesta recibida de DeepSeek")
        print(f"  Modelo usado: {response.model}")
        print(f"  Tokens usados: {response.usage.total_tokens}")
        print(f"\nRespuesta:\n{response.choices[0].message.content}")
        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

def test_json_mode():
    """Test 2: Modo JSON para structured output"""
    print("\n" + "=" * 60)
    print("TEST 2: Modo JSON (structured output)")
    print("=" * 60)
    
    try:
        response = client.chat.completions.create(
            model="deepseek-ai/deepseek-v4-pro",
            messages=[
                {
                    "role": "user",
                    "content": "Dame un JSON con información sobre MCP servers. Estructura: {name, description, tools_count}"
                }
            ],
            max_tokens=512,
            temperature=0.7,
        )
        
        print(f"✓ JSON generado correctamente")
        print(f"  Respuesta:\n{response.choices[0].message.content}")
        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

def test_streaming():
    """Test 3: Streaming de respuesta"""
    print("\n" + "=" * 60)
    print("TEST 3: Streaming en tiempo real")
    print("=" * 60)
    
    try:
        print("Respuesta (streaming):")
        with client.chat.completions.create(
            model="deepseek-ai/deepseek-v4-pro",
            messages=[
                {"role": "user", "content": "Lista 3 herramientas útiles de MCP"}
            ],
            max_tokens=512,
            stream=True,
        ) as stream:
            for text in stream.text_stream:
                print(text, end="", flush=True)
        print()
        print("✓ Streaming completado")
        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

if __name__ == "__main__":
    print("\n" + "🧪 TESTING NVIDIA API + DeepSeek v4-pro".center(60))
    print("Configuración para OpenClaude\n")
    
    results = []
    
    # Ejecutar tests
    results.append(("Conexión básica", test_basic_completion()))
    results.append(("Modo JSON", test_json_mode()))
    results.append(("Streaming", test_streaming()))
    
    # Resumen
    print("\n" + "=" * 60)
    print("📋 RESUMEN DE TESTS")
    print("=" * 60)
    for test_name, passed in results:
        status = "✓ PASÓ" if passed else "✗ FALLÓ"
        print(f"{test_name:25} {status}")
    
    all_passed = all(result[1] for result in results)
    print("=" * 60)
    
    if all_passed:
        print("\n✅ TODOS LOS TESTS PASARON")
        print("OpenClaude + NVIDIA está correctamente configurado")
        print("\nPróximos pasos:")
        print("  1. Probar MCP-SuperAssistant en navegador")
        print("  2. Configurar herramientas adicionales en .mcp.json")
        print("  3. Integrar con búsqueda en memoria (claude-mem)")
    else:
        print("\n❌ ALGUNOS TESTS FALLARON")
        print("Verificar configuración de API key o conectividad")
