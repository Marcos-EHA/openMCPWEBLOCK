import { describe, expect, it } from 'bun:test';
import { createPromptImageFiles } from './promptImage';

function mockCanvasFactory(
  renderedText: string[][],
  dimensions: number[][],
  transforms: number[][],
) {
  return () => {
    let width = 0;
    let height = 0;
    const context = {
      font: '',
      fillStyle: '',
      textBaseline: '',
      measureText: (text: string) => ({ width: text.length * 10 }),
      setTransform: (...values: number[]) => transforms.push(values),
      fillRect: () => undefined,
      fillText: (text: string) => {
        const pageTexts = renderedText.at(-1);
        pageTexts?.push(text);
      },
    };
    const canvas = {
      get width() {
        return width;
      },
      set width(value: number) {
        width = value;
      },
      get height() {
        return height;
      },
      set height(value: number) {
        height = value;
        dimensions.push([width, height]);
        renderedText.push([]);
      },
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(['png-data'], { type: 'image/png' })),
    };
    return canvas;
  };
}

describe('createPromptImageFiles', () => {
  it('renders readable 2x PNG pages with line breaks and page labels', async () => {
    const renderedText: string[][] = [];
    const dimensions: number[][] = [];
    const transforms: number[][] = [];
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: mockCanvasFactory(renderedText, dimensions, transforms) },
    });
    const prompt = Array.from({ length: 65 }, (_, index) => `line ${index}`).join('\n');

    try {
      const files = await createPromptImageFiles(prompt);

      expect(files.map(file => file.name)).toEqual([
        'superassistant-instructions-001-of-003.png',
        'superassistant-instructions-002-of-003.png',
        'superassistant-instructions-003-of-003.png',
      ]);
      expect(files.every(file => file.type === 'image/png')).toBe(true);
      expect(dimensions.every(([width, height]) => width === 3200 && height <= 3000)).toBe(true);
      expect(transforms).toEqual(Array.from({ length: 3 }, () => [2, 0, 0, 2, 0, 0]));
      expect(renderedText.map(page => page[0])).toEqual([
        'SuperAssistant instructions - page 1/3',
        'SuperAssistant instructions - page 2/3',
        'SuperAssistant instructions - page 3/3',
      ]);
      expect(renderedText.flatMap(page => page.slice(1))).toEqual(
        Array.from({ length: 65 }, (_, index) => `line ${index}`),
      );
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('rejects empty prompts instead of producing an empty attachment', async () => {
    await expect(createPromptImageFiles(' \n ')).rejects.toThrow(
      'Cannot create a prompt image from empty instructions.',
    );
  });

  it('rejects prompts that would exceed the supported image-page limit', async () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ getContext: () => ({
        font: '',
        textBaseline: '',
        measureText: (text: string) => ({ width: text.length * 10 }),
      }) }) },
    });

    try {
      const prompt = Array.from({ length: 385 }, (_, index) => `line ${index}`).join('\n');
      await expect(createPromptImageFiles(prompt)).rejects.toThrow(
        'The selected prompt needs more than 12 image pages.',
      );
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('wraps long lines without dropping prompt characters', async () => {
    const renderedText: string[][] = [];
    const dimensions: number[][] = [];
    const transforms: number[][] = [];
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const canvas = mockCanvasFactory(renderedText, dimensions, transforms)();
          const context = canvas.getContext('2d');
          context.measureText = (text: string) => ({ width: text.length * 100 });
          return canvas;
        },
      },
    });
    const longLine = 'abcdefghij'.repeat(20);

    try {
      await createPromptImageFiles(longLine);
      expect(renderedText[0].slice(1).join('')).toBe(longLine);
      expect(renderedText[0].length).toBeGreaterThan(2);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
