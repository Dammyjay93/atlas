/** One visible element on a captured page, with its box in CSS pixels from the top of the page. */
export interface LayoutItem {
  tag: string;
  /** The element's own text, or its accessible name; for a surface, the start of the text inside it. */
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True for an element drawn as a surface (a background, border or shadow) rather than for its text. */
  surface?: true;
}

/**
 * Runs in the page: lists every element a person can see in the picture, with its box. That is text, controls, images and icons,
 * and surfaces with a background, border or shadow. Compare matches these between live and the branch to name and outline exactly
 * what changed. An element counts as seen when the browser draws it and nothing else covers its centre. `fullPage` keeps elements
 * below the first screen. Self-contained, because Playwright sends it to the page as source.
 */
export function layoutMap(fullPage: boolean): LayoutItem[] {
  const items: LayoutItem[] = [];
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const seen = (el: Element, r: DOMRect) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return fullPage;
    const top = document.elementFromPoint(cx, cy);
    return !!top && (el.contains(top) || top.contains(el));
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.closest("script, style, noscript, template") || el.parentElement?.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const y = r.top + window.scrollY;
    if (!fullPage && (y >= window.innerHeight || r.bottom <= 0)) continue;
    const tag = el.tagName.toLowerCase();
    let text = "";
    for (const node of Array.from(el.childNodes)) if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    text = clean(text);
    const control = el.matches("button, a, [role=button], input, select, textarea");
    const picture = el.matches("img, svg, video, canvas, picture");
    if (!text && (control || picture)) {
      const field = el as HTMLInputElement;
      text = clean(el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title") ?? (el.matches("input, textarea") ? field.value || field.placeholder : ""));
    }
    const style = getComputedStyle(el);
    const surface =
      !text && !picture &&
      ((style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
        style.backgroundImage !== "none" ||
        style.boxShadow !== "none" ||
        ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none"));
    if (!text && !picture && !control && !surface) continue;
    if (!seen(el, r)) continue;
    const box = { x: Math.round(r.left + window.scrollX), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
    if (surface) items.push({ tag, text: clean(el.textContent).slice(0, 60), ...box, surface: true });
    else items.push({ tag, text, ...box });
  }
  return items;
}
