import { fileInputAcceptsFile } from './fileInputCompatibility';

export interface ClaudeFileInputCandidate {
  accept: string;
  disabled: boolean;
}

export function findClaudeFileInput<T extends ClaudeFileInputCandidate>(
  inputs: readonly T[],
  file: Pick<File, 'name' | 'type'>,
): T | null {
  return inputs.find(input => !input.disabled && fileInputAcceptsFile(input, file)) ?? null;
}
