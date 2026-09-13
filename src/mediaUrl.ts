export function registryMediaUrl(src: string, registry: string): string | null {
  try {
    const url = new URL(src, registry);
    if (url.origin !== new URL(registry).origin) return null;
    if (url.pathname.startsWith('/api/v1/media/')) url.pathname = url.pathname.replace('/api/v1/media/', '/media/');
    else if (url.pathname.startsWith('/api/v1/previews/')) url.pathname = url.pathname.replace('/api/v1/previews/', '/media/previews/');
    else if (!url.pathname.startsWith('/media/')) return null;
    return url.href;
  } catch { return null; }
}
