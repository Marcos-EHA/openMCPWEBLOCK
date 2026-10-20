const IMAGE_WIDTH = 1600;
const IMAGE_SCALE = 2;
const HORIZONTAL_PADDING = 48;
const VERTICAL_PADDING = 48;
const HEADER_HEIGHT = 48;
const FONT_SIZE = 30;
const LINE_HEIGHT = 40;
const LINES_PER_IMAGE = 32;
const MAX_CANVAS_PIXELS = 10_000_000;
const MAX_IMAGE_PAGES = 12;

function wrapLine(
  context: CanvasRenderingContext2D,
  line: string,
  maxWidth: number,
): string[] {
  if (line.length === 0) return [''];

  const wrapped: string[] = [];
  let start = 0;
  while (start < line.length) {
    let low = start + 1;
    let high = line.length;
    let end = start + 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (context.measureText(line.slice(start, middle)).width <= maxWidth) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (end < line.length) {
      const lastSpace = line.lastIndexOf(' ', end - 1);
      if (lastSpace > start) end = lastSpace;
    }

    wrapped.push(line.slice(start, end));
    start = end;
  }

  return wrapped;
}

async function renderPromptPage(lines: string[], page: number, pageCount: number): Promise<Blob> {
  const logicalHeight =
    VERTICAL_PADDING * 2 + HEADER_HEIGHT + lines.length * LINE_HEIGHT;
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH * IMAGE_SCALE;
  canvas.height = logicalHeight * IMAGE_SCALE;
  if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) {
    throw new Error('The selected prompt image page exceeds the safe image size.');
  }

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The browser could not create a canvas for the prompt image.');
  }
  context.setTransform(IMAGE_SCALE, 0, 0, IMAGE_SCALE, 0, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, IMAGE_WIDTH, logicalHeight);
  context.fillStyle = '#111827';
  context.font = `bold ${FONT_SIZE}px "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
  context.textBaseline = 'top';
  context.fillText(`SuperAssistant instructions - page ${page}/${pageCount}`, HORIZONTAL_PADDING, VERTICAL_PADDING);
  context.font = `${FONT_SIZE}px "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
  lines.forEach((line, index) => {
    context.fillText(
      line,
      HORIZONTAL_PADDING,
      VERTICAL_PADDING + HEADER_HEIGHT + index * LINE_HEIGHT,
    );
  });

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(result => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error('The browser could not encode the prompt image as PNG.'));
      }
    }, 'image/png');
  });
}

export async function createPromptImageFiles(prompt: string): Promise<File[]> {
  if (!prompt.trim()) {
    throw new Error('Cannot create a prompt image from empty instructions.');
  }

  const measureCanvas = document.createElement('canvas');
  const context = measureCanvas.getContext('2d');
  if (!context) {
    throw new Error('The browser could not create a canvas for the prompt image.');
  }

  context.font = `${FONT_SIZE}px "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
  context.textBaseline = 'top';
  const lines = prompt.split(/\r\n|\r|\n/).flatMap(line =>
    wrapLine(context, line, IMAGE_WIDTH - HORIZONTAL_PADDING * 2),
  );
  const pages = Array.from(
    { length: Math.ceil(lines.length / LINES_PER_IMAGE) },
    (_, index) => lines.slice(index * LINES_PER_IMAGE, (index + 1) * LINES_PER_IMAGE),
  );
  if (pages.length > MAX_IMAGE_PAGES) {
    throw new Error(`The selected prompt needs more than ${MAX_IMAGE_PAGES} image pages.`);
  }

  const files: File[] = [];
  for (let index = 0; index < pages.length; index++) {
    const page = index + 1;
    const blob = await renderPromptPage(pages[index], page, pages.length);
    const pageLabel = String(page).padStart(3, '0');
    const pageCountLabel = String(pages.length).padStart(3, '0');
    files.push(new File([blob], `superassistant-instructions-${pageLabel}-of-${pageCountLabel}.png`, {
      type: 'image/png',
    }));
  }
  return files;
}
