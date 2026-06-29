import DOMPurify from "dompurify";

const UNSAFE_STYLE_VALUE = /(?:url\s*\(|expression\s*\(|javascript\s*:)/i;

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0 && !UNSAFE_STYLE_VALUE.test(declaration))
    .join("; ");
}

function dropStyleElement(node: Node): void {
  if (node.nodeName.toLowerCase() === "style") {
    node.parentNode?.removeChild(node);
  }
}

function scrubStyleAttribute(node: Node): void {
  if (!(node instanceof Element)) return;
  const style = node.getAttribute("style");
  if (style === null) return;
  const safe = sanitizeStyle(style);
  if (safe.length === 0) node.removeAttribute("style");
  else node.setAttribute("style", safe);
}

export function sanitizeHtml(dirty: string): string {
  // IMPORTANT: scope our hooks to THIS call only. DOMPurify is a singleton that
  // mermaid (and potentially other libs) share; mermaid sanitizes its rendered
  // SVG — which contains an internal <style> element — IN PLACE. A persistent
  // global <style>-removing hook fires inside mermaid's sanitize and breaks its
  // in-place node removal ("a node selected for removal could not be detached…"),
  // orphaning the diagram. Adding the hooks per-call (sanitizeHtml is synchronous,
  // so nothing interleaves) keeps our sanitization strict without leaking into
  // anyone else's DOMPurify usage.
  const canHook = typeof DOMPurify.addHook === "function";
  if (canHook) {
    DOMPurify.addHook("uponSanitizeElement", dropStyleElement);
    DOMPurify.addHook("afterSanitizeAttributes", scrubStyleAttribute);
  }
  try {
    return DOMPurify.sanitize(dirty, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      ADD_ATTR: ["data-icon", "style"],
      FORBID_TAGS: ["style"],
    });
  } finally {
    if (canHook) {
      DOMPurify.removeHook("uponSanitizeElement");
      DOMPurify.removeHook("afterSanitizeAttributes");
    }
  }
}

export { sanitizeStyle };
