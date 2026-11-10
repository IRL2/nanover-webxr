import { Texture, TextureLoader } from 'three';

export async function loadResourceTexture(
  runCommand: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
  textureKey: string,
): Promise<Texture> {
  const response = await runCommand('resources/fetch', { key: textureKey });
  const data = (response as { data?: unknown } | undefined)?.data;

  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new Error(`Resource ${textureKey} returned invalid MessagePack image bytes`);
  }

  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'image/png' }));
  try {
    return await new TextureLoader().loadAsync(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
