import sharp from 'sharp';

export interface ImageStats {
  width: number;
  height: number;
  totalPixels: number;
  colorCounts: Record<string, number>;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export async function processImageStats(input: Buffer | string): Promise<ImageStats> {
  const metadata = await sharp(input).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  // Obtenir les pixels bruts (RGBA)
  const rawInfo = await sharp(input)
    .ensureAlpha() // S'assurer qu'on a bien le canal alpha
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data } = rawInfo;
  let totalValidPixels = 0;
  const colorCounts: Record<string, number> = {};

  // Parcourir chaque pixel (4 bytes par pixel: R, G, B, A)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const a = data[i + 3] as number;

    // Ignorer les pixels transparents
    if (a === 0) {
      continue;
    }

    // Le pixel est visible
    totalValidPixels++;
    const hex = rgbToHex(r, g, b);

    if (colorCounts[hex]) {
      colorCounts[hex]++;
    } else {
      colorCounts[hex] = 1;
    }
  }

  return {
    width,
    height,
    totalPixels: totalValidPixels,
    colorCounts
  };
}
