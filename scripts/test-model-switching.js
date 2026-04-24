#!/usr/bin/env node

/**
 * Test script for automatic model switching functionality
 * Run with: node scripts/test-model-switching.js
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Test cases for different task types
const testCases = [
  {
    input: "Hola, ¿cómo estás?",
    expectedType: "conversacion",
    expectedModel: "neural-chat"
  },
  {
    input: "Escribe una función en Python para calcular el factorial",
    expectedType: "codigo",
    expectedModel: "codellama:7b-code"
  },
  {
    input: "Explica cómo funciona este algoritmo de machine learning",
    expectedType: "analisis",
    expectedModel: "mistral"
  },
  {
    input: "Debug this JavaScript error: TypeError: Cannot read property",
    expectedType: "debugging",
    expectedModel: "codellama:7b-code"
  },
  {
    input: "Busca información sobre machine learning",
    expectedType: "busqueda",
    expectedModel: "mistral"
  },
  {
    input: "Documenta esta API con JSDoc comments",
    expectedType: "documentacion",
    expectedModel: "neural-chat"
  }
];

// Mock the learning-system directory for testing
const mockStrategyPath = join(process.cwd(), 'test-modelo-strategy.json');

const mockStrategy = {
  "estrategia_global": "seleccionar_por_tarea_automaticamente",
  "modelos_disponibles": {
    "codellama:7b-code": {
      "mejor_para": ["generar código", "debugging", "explicar sintaxis"],
      "latencia": "2-5s",
      "exactitud": "85%",
      "estado_instalacion": "instalado"
    },
    "neural-chat": {
      "mejor_para": ["conversación", "pregunta-respuesta", "resumen"],
      "latencia": "2-5s",
      "exactitud": "80%",
      "estado_instalacion": "instalado"
    },
    "mistral": {
      "mejor_para": ["razonamiento", "análisis", "búsqueda"],
      "latencia": "3-7s",
      "exactitud": "75%",
      "estado_instalacion": "instalado"
    }
  },
  "fallback_strategy": "neural-chat"
};

// Create mock strategy file
writeFileSync(mockStrategyPath, JSON.stringify(mockStrategy, null, 2));

console.log("🧪 Testing Automatic Model Switching\n");

function classifyTask(userInput) {
  const input = userInput.toLowerCase();

  const codeKeywords = [
    'código', 'función', 'script', 'python', 'javascript', 'typescript',
    'java', 'c++', 'php', 'ruby', 'go', 'rust', 'sql', 'html', 'css',
    'api', 'endpoint', 'database', 'query', 'algoritmo', 'clase',
    'método', 'variable', 'constante', 'import', 'export', 'async',
    'await', 'promise', 'callback', 'framework', 'librería', 'paquete',
    'dependencia', 'build', 'compile', 'syntax', 'parsing', 'token', 'lexer', 'parser'
  ];

  const analysisKeywords = [
    'analizar', 'explicar', 'razonar', 'comparar', 'evaluar', 'resumir',
    'interpretar', 'concluir', 'argumentar', 'evidencia', 'prueba',
    'hipótesis', 'teoría', 'concepto', 'paradigma', 'arquitectura',
    'diseño', 'patrón', 'estrategia', 'metodología', 'enfoque',
    'perspectiva', 'visión', 'diagnóstico', 'auditoría'
  ];

  const searchKeywords = [
    'buscar', 'encontrar', 'localizar', 'investigar', 'documentación',
    'manual', 'guía', 'tutorial', 'referencia', 'documento', 'archivo',
    'leer', 'revisar', 'consultar', 'verificar', 'confirmar', 'validar'
  ];

  const debugKeywords = [
    'debug', 'depurar', 'error', 'bug', 'problema', 'issue', 'fix',
    'solucionar', 'corregir', 'arreglar', 'reparar', 'troubleshoot',
    'diagnosticar', 'investigar', 'trace', 'log', 'exception', 'crash'
  ];

  const docKeywords = [
    'documentar', 'readme', 'md', 'markdown', 'wiki',
    'comentario', 'docstring', 'javadoc', 'comentarios'
  ];

  // Count matches for each category
  const codeMatches = codeKeywords.filter(k => input.includes(k)).length;
  const analysisMatches = analysisKeywords.filter(k => input.includes(k)).length;
  const searchMatches = searchKeywords.filter(k => input.includes(k)).length;
  const debugMatches = debugKeywords.filter(k => input.includes(k)).length;
  const docMatches = docKeywords.filter(k => input.includes(k)).length;

  // Special handling for debugging: boost if error-related
  const hasErrorKeywords = ['error', 'exception', 'bug', 'crash', 'problema'].some(k => input.includes(k));
  const boostedDebugScore = hasErrorKeywords ? debugMatches * 1.5 : debugMatches;

  // Special handling for analysis: reduce if also contains code keywords
  const analysisScore = (codeMatches > 0) ? analysisMatches * 0.5 : analysisMatches;

  const scores = [
    { type: 'codigo', score: codeMatches },
    { type: 'analisis', score: analysisScore },
    { type: 'busqueda', score: searchMatches },
    { type: 'debugging', score: boostedDebugScore },
    { type: 'documentacion', score: docMatches }
  ];

  const maxScore = Math.max(...scores.map(s => s.score));
  const bestMatch = scores.find(s => s.score === maxScore);

  // If no significant matches, default to conversation
  if (maxScore === 0) {
    return {
      type: 'conversacion',
      confidence: 0.5,
      keywords: []
    };
  }

  // Calculate confidence based on match ratio and uniqueness
  const totalMatches = codeMatches + analysisMatches + searchMatches + debugMatches + docMatches;
  let confidence = totalMatches > 0 ? maxScore / totalMatches : 0;

  // Boost confidence for clear task indicators
  if (input.includes('escribe') && input.includes('función')) confidence = Math.min(confidence * 1.3, 1.0);
  if (hasErrorKeywords && debugMatches > 0) confidence = Math.min(confidence * 1.2, 1.0);
  if (input.includes('analiz') && !input.includes('código')) confidence = Math.min(confidence * 1.1, 1.0);

  return {
    type: bestMatch?.type || 'conversacion',
    confidence: Math.min(confidence, 1.0),
    keywords: [
      ...codeKeywords.filter(k => input.includes(k)),
      ...analysisKeywords.filter(k => input.includes(k)),
      ...searchKeywords.filter(k => input.includes(k)),
      ...debugKeywords.filter(k => input.includes(k)),
      ...docKeywords.filter(k => input.includes(k))
    ].slice(0, 5)
  };
}

function getOptimalModel(userQuery) {
  try {
    if (!existsSync(mockStrategyPath)) {
      console.error(`Strategy file not found: ${mockStrategyPath}`);
      return 'neural-chat';
    }
    const content = readFileSync(mockStrategyPath, 'utf-8');
    const strategy = JSON.parse(content);

    const classification = classifyTask(userQuery);

    const taskToModelMap = {
      'codigo': ['codellama:7b-code', 'codellama', 'codegemma', 'codestral'],
      'debugging': ['codellama:7b-code', 'codellama', 'deepseek-coder'],
      'analisis': ['mistral', 'qwen2.5', 'llama2:13b', 'neural-chat'],
      'busqueda': ['mistral', 'qwen2.5', 'neural-chat'],
      'documentacion': ['neural-chat', 'mistral', 'qwen2.5'],
      'conversacion': ['neural-chat', 'mistral', 'qwen2.5']
    };

    const candidateModels = taskToModelMap[classification.type] || [strategy.fallback_strategy];

    for (const modelName of candidateModels) {
      if (strategy.modelos_disponibles[modelName] &&
          strategy.modelos_disponibles[modelName].estado_instalacion === 'instalado') {
        return modelName;
      }
    }

    return strategy.fallback_strategy;
  } catch (error) {
    console.error(`Error getting optimal model: ${error}`);
    return 'neural-chat';
  }
}

// Run tests
let passedTests = 0;
let totalTests = testCases.length;

testCases.forEach((testCase, index) => {
  console.log(`\n📝 Test ${index + 1}: "${testCase.input}"`);

  const classification = classifyTask(testCase.input);
  const selectedModel = getOptimalModel(testCase.input);

  console.log(`   Expected type: ${testCase.expectedType}`);
  console.log(`   Detected type: ${classification.type}`);
  console.log(`   Confidence: ${(classification.confidence * 100).toFixed(1)}%`);
  console.log(`   Expected model: ${testCase.expectedModel}`);
  console.log(`   Selected model: ${selectedModel}`);

  const typeMatch = classification.type === testCase.expectedType;
  const modelMatch = selectedModel.includes(testCase.expectedModel) ||
                    testCase.expectedModel.includes(selectedModel.split(':')[0]);

  if (typeMatch && modelMatch) {
    console.log(`   ✅ PASSED`);
    passedTests++;
  } else {
    console.log(`   ❌ FAILED`);
  }
});

console.log(`\n📊 Test Results: ${passedTests}/${totalTests} passed`);

if (passedTests === totalTests) {
  console.log("🎉 All tests passed! Automatic model switching is working correctly.");
} else {
  console.log("⚠️  Some tests failed. Please review the classification logic.");
}

// Cleanup
try {
  unlinkSync(mockStrategyPath);
  console.log("\n🧹 Cleaned up test files");
} catch (e) {
  // Ignore cleanup errors
}