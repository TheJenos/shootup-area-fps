/** Creates a canvas and its 2D context, for procedurally drawn textures. */
export function canvas2d(width: number, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas is not supported');
  return { canvas, g };
}
