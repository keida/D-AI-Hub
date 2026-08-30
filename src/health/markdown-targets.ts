export function markdownDestinations(markdown: string): readonly string[] {
  const destinations: string[] = [];
  const linkPattern = /!?(?:\[[^\]]*\])\(\s*(<[^>]*>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const destination = match[1];
    if (destination === undefined) continue;
    destinations.push(destination.startsWith("<") && destination.endsWith(">")
      ? destination.slice(1, -1)
      : destination);
  }
  return destinations;
}

export function localMarkdownTarget(destination: string): string | null {
  const trimmed = destination.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  if (!/^[A-Za-z]:[\\/]/.test(trimmed) && /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)) return null;
  const fragmentIndex = trimmed.indexOf("#");
  const pathPart = fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
  if (pathPart.length === 0) return null;
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}
