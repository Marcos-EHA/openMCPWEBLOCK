export interface FileInputAccept {
  accept: string;
}

export function fileInputAcceptsFile(
  input: FileInputAccept,
  file: Pick<File, 'name' | 'type'>,
): boolean {
  const acceptedTypes = input.accept
    .split(',')
    .map(type => type.trim().toLowerCase())
    .filter(Boolean);

  if (acceptedTypes.length === 0) return true;

  const fileName = file.name.toLowerCase();
  const mimeType = file.type.toLowerCase();

  return acceptedTypes.some(acceptedType => {
    if (acceptedType.startsWith('.')) return fileName.endsWith(acceptedType);
    if (acceptedType.endsWith('/*')) {
      return mimeType.startsWith(acceptedType.slice(0, -1));
    }
    return mimeType === acceptedType;
  });
}
