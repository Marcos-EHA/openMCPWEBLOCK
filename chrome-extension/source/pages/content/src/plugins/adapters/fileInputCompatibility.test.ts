import { describe, expect, it } from 'bun:test';
import { fileInputAcceptsFile } from './fileInputCompatibility';

describe('fileInputAcceptsFile', () => {
  const promptFile = { name: 'instructions.txt', type: 'text/plain' };

  it('accepts files when the page does not restrict input types', () => {
    expect(fileInputAcceptsFile({ accept: '' }, promptFile)).toBe(true);
  });

  it('accepts a matching MIME type or file extension', () => {
    expect(fileInputAcceptsFile({ accept: 'text/plain, .md' }, promptFile)).toBe(true);
    expect(fileInputAcceptsFile({ accept: '.TXT' }, promptFile)).toBe(true);
  });

  it('rejects a text prompt when the page only accepts images', () => {
    expect(fileInputAcceptsFile({ accept: 'image/*' }, promptFile)).toBe(false);
  });

  it('matches wildcard MIME types', () => {
    expect(fileInputAcceptsFile({ accept: 'text/*' }, promptFile)).toBe(true);
  });
});
