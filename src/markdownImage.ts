export function markdownImage(markdown?: string | null) {
  const match = markdown?.match(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/);
  return match?.[1] || match?.[2];
}
