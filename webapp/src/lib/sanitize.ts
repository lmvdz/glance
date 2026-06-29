import DOMPurify from "dompurify";

const UNSAFE_STYLE_VALUE = /(?:url\s*\(|expression\s*\(|javascript\s*:)/i;

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0 && !UNSAFE_STYLE_VALUE.test(declaration))
    .join("; ");
}

if (typeof DOMPurify.addHook === "function") {
  DOMPurify.addHook("uponSanitizeElement", (node) => {
    if (node.nodeName.toLowerCase() === "style") {
      node.parentNode?.removeChild(node);
    }
  });

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) {
      return;
    }

    const style = node.getAttribute("style");
    if (style === null) {
      return;
    }

    const safeStyle = sanitizeStyle(style);
    if (safeStyle.length === 0) {
      node.removeAttribute("style");
      return;
    }

    node.setAttribute("style", safeStyle);
  });
}

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ["data-icon", "style"],
    FORBID_TAGS: ["style"],
  });
}

export { sanitizeStyle };
