# Instructions Component

This directory contains components and utilities for generating and displaying instructions for using MCP tools.

In the compact SuperAssistant configuration, **Instructions** provides the exact original prompt supplied as `Pasted text #1`, the Updated JSONL prompt, **Claude (dedicado para Claude)**, a user-authored prompt, and **Selected prompt as image (pensado para modo invitado)**. The original prompt is bundled verbatim in `originalSuperAssistantPrompt.txt`. The Claude-specific prompt is stored in `claudeDedicatedPrompt.txt` and includes the user's prompt plus a concise clarification of the four JSONL event lines after its example placeholder. The Claude entry is fixed text and does not append generated tools, schemas, or custom instructions. The image option keeps the chosen prompt source (Original, Updated, Claude, Custom, or Agent mode) and renders it into multiple high-resolution PNG pages with readable text and page numbers. Choose it explicitly when using a Guest page that accepts images.

The separately grouped **Agent mode (dynamic prompt)** toggle generates an XML prompt from enabled MCP tools and their schemas. It is not the Original prompt and does not replace the Original, Updated, Claude, or Custom choices. To test Claude's JSONL flow, select **Claude (dedicado para Claude)** and turn Agent mode off so Insert uses that exact prompt.

**Insert** places the active prompt text in the chat composer. **Attach** follows the selected mode: text-based prompt sources are attached as a text file; the Guest image option attaches all generated PNG pages in one operation. Attach does not silently convert text prompts into images. The prompt selection, image source, agent-mode toggle, and custom prompt are stored in user preferences.

## Files

- `instructionGenerator.ts`: Generates markdown instructions for using MCP tools based on available tools.
- `instructionGeneratorJson.ts`: Generates the current JSONL-based prompt and returns the fixed Claude-specific prompt.
- `originalSuperAssistantPrompt.txt`: Exact static Original prompt supplied by the user.
- `claudeDedicatedPrompt.txt`: Exact static Claude-specific prompt supplied by the user.
- `selectPrompt.ts`: Selects the prompt source shared by compact and sidebar actions.
- `schema_converter.ts`: Utilities for converting between JSON Schema and Compressed Schema Notation (CSN).

## Recent Changes

- Added schema compression functionality to display tool schemas in a more compact format.
- Implemented error handling during schema conversion to ensure the application continues to work even if some schemas fail to convert.
- Added exports to schema_converter.ts to make it a proper module.

## Compressed Schema Notation (CSN)

CSN is a compact notation for representing JSON Schema. It uses short codes to represent different schema types and structures:

- `o`: Object
- `p {}`: Properties block
- `s`: String
- `i`: Integer
- `n`: Number
- `b`: Boolean
- `a`: Array
- `r`: Required
- `ap f`: Additional properties false

For example, a simple schema like:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

Is represented in CSN as:
```
o {p {path:s r} ap f}
```

This makes it easier to quickly understand the structure of a tool's schema without having to parse the full JSON Schema. 