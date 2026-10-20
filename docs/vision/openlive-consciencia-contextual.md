# Visión: IA con Consciencia Contextual en OpenLive + openweblock

> Documentado: 2026-09-04 | Autor de la visión: Elías

## Concepto Central

La IA no debe tomar decisiones a ciegas. Antes de sugerir o actuar, debe **entender su entorno**: el hardware del usuario, los recursos disponibles, las APIs configuradas, y el contexto de la situación.

## Principios

1. **No perder funcionalidad** — OpenLive funciona independiente, pero con openweblock gana más capacidades
2. **El usuario siempre decide** — La IA informa y propone alternativas, nunca fuerza acciones
3. **Consciencia de recursos** — Saber qué APIs están cerca de agotarse, qué hardware tiene el usuario, qué alternativas existen
4. **Tier gratuito primero** — El sistema debe funcionar completamente con recursos gratuitos (APIs free tier + modelos locales open-source)

## Escenarios Contemplados

### Agotamiento de API
- La IA detecta que ElevenLabs tiene 95% de chars usados
- **NO auto-cambia** a modelos locales (el PC puede ser lento)
- Muestra alerta visual en el panel de stats durante la llamada
- Ofrece opciones:
  - "Seguir usando hasta agotar"
  - "La IA busca una API gratuita alternativa y la configura"
  - "Cambiar a voz local" (solo si el hardware lo soporta)
  - "Continuar sin voz (solo texto)"

### Evaluación de Hardware
- Antes de sugerir modelos locales, evaluar:
  - GPU (¿tiene WebGPU? ¿cuánta VRAM?)
  - RAM disponible
  - CPU
- Basándose en eso, recomendar o descartar opciones locales
- Pedir permiso antes de recoger datos del sistema

### Ingeniería Inversa del Contexto
Concepto del usuario: "Si una persona toma una foto para que la IA la analice, ¿qué pasaría si la IA evaluara primero la cámara, conversara con el usuario, y propusiera usar un mejor dispositivo?"

Aplicado a OpenLive:
- La IA evalúa la calidad del micrófono antes de iniciar
- Si detecta problemas, sugiere: "Tu micrófono Voicemod parece virtual. ¿Tienes otro disponible?"
- Analiza la conexión de red antes de elegir APIs cloud vs local
- Propone soluciones basadas en lo que REALMENTE tiene el usuario

### Autogestión de la IA
- La IA podría tener acceso controlado a su propia configuración de OpenLive
- Ejemplo: "Se me están agotando los caracteres de ElevenLabs. Encontré que Coqui TTS es gratuito y compatible. ¿Quieres que lo configure?"
- Apartados especiales donde la IA puede actuar en su propio sistema
- Siempre como alternativa que las alertas ofrecen, no como acción automática

### Integración con openweblock
- Si openweblock está conectado, la IA puede usar sus herramientas para:
  - Buscar APIs gratuitas alternativas
  - Investigar compatibilidad de hardware
  - Implementar soluciones técnicas
- Si openweblock NO está disponible, OpenLive sigue funcionando independiente

### Acceso Remoto
- Con openweblock instalado, los datos del sistema podrían ser accesibles remotamente
- Permite usar OpenLive desde cualquier dispositivo con conocimiento del sistema principal
- Requiere atención a seguridad y permisos

## Escenarios de Usuario

### Usuario apurado
- La IA detecta urgencia en el contexto de la conversación
- Minimiza las alertas, prioriza la tarea
- Resuelve problemas de recursos silenciosamente si tiene alternativas claras

### Usuario sin APIs disponibles
- Prioriza conversación sobre la situación
- Ayuda a configurar nuevas APIs gratuitas
- Explica opciones disponibles

### Usuario con hardware limitado
- No sugiere opciones locales pesadas
- Prioriza soluciones cloud
- Si no hay cloud disponible, sugiere configuraciones mínimas

## Separación de Responsabilidades

| Componente | Responsabilidad |
|-----------|----------------|
| OpenLive | Interfaz de voz, chat, monitoreo de APIs |
| openweblock | Herramientas, investigación, implementación |
| IA (Gemini) | Inteligencia, decisiones, consciencia contextual |

## Pendientes Técnicos

- [ ] Alertas visuales en panel de stats (en progreso)
- [ ] Evaluación de hardware del usuario (concepto)
- [ ] API de autogestión para la IA (concepto)
- [ ] Conexión OpenLive ↔ openweblock para resolución de problemas (pendiente)
- [ ] Sistema de permisos para recolección de datos del sistema
- [ ] Apartado de feedback para el desarrollador en OpenLive

## Notas

- Los avances de IA externas vs Antigravity deben separarse (git/github)
- La documentación de ideas debe organizarse mejor en openweblock
- Hay documentación previa en openweblock que necesita revisión y organización
