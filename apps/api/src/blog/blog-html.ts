import sanitizeHtml from "sanitize-html";

/** Only presentation markup; never scripts, forms, event handlers or arbitrary CSS. */
export function cleanBlogHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "div", "span", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "br", "hr", "ul", "ol", "li", "blockquote", "a", "img", "figure", "figcaption"],
    allowedAttributes: { "*": ["style", "dir"], a: ["href", "title", "rel"], img: ["src", "alt", "width", "loading"] },
    allowedSchemes: ["https", "mailto", "tel"],
    allowProtocolRelative: false,
    allowedStyles: { "*": {
      "font-family": [/^(Arial|Georgia|Verdana|Tahoma|sans-serif|serif)$/i],
      "font-size": [/^(12|14|16|18|20|24|28|32|36|48)px$/],
      "font-weight": [/^(normal|bold|[1-9]00)$/],
      "font-style": [/^(normal|italic)$/],
      "text-decoration": [/^(none|underline|line-through)$/],
      "text-align": [/^(left|right|center|justify)$/],
      "color": [/^#[0-9a-f]{3,6}$/i],
      "width": [/^(25|50|75|100)%$/],
    } },
    transformTags: {
      h1: "h2", // The article title owns the single H1.
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer" } }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy" } }),
    },
    exclusiveFilter: frame => frame.tag === "img" && !/^(https:\/\/|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+$)/i.test(frame.attribs.src ?? ""),
  }).trim();
}
