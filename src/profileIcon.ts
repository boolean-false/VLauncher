export async function profileIcon(blob: Blob): Promise<string> {
  if (blob.size > 10 * 1024 * 1024)
    throw new Error("Выберите изображение до 10 МБ");
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("Не удалось прочитать изображение");
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Не удалось обработать изображение");
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - size) / 2,
      (image.naturalHeight - size) / 2,
      size,
      size,
      0,
      0,
      256,
      256,
    );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
