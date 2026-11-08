/**
 * Runs in the captured page. Returns the page as one self-contained HTML file: stylesheets, fonts and images inlined,
 * scripts removed, form values written into the markup. The viewer draws it as a real page that never runs code.
 */
export async function snapshotPage(): Promise<string> {
  const cache = new Map<string, Promise<string>>();
  const toData = (url: string): Promise<string> => {
    if (url.startsWith("data:")) return Promise.resolve(url);
    let pending = cache.get(url);
    if (!pending) {
      pending = fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${url}`);
          return res.blob();
        })
        .then((blob) => new Promise<string>((done) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result));
          reader.readAsDataURL(blob);
        }));
      cache.set(url, pending);
    }
    return pending;
  };
  const inlineUrls = async (css: string, from: string): Promise<string> => {
    for (const match of [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]) {
      const ref = match[2] ?? "";
      if (!ref || ref.startsWith("data:") || ref.startsWith("#")) continue;
      try {
        css = css.split(match[0]).join(`url("${await toData(new URL(ref, from).href)}")`);
      } catch {
        // A resource that cannot be fetched stays as its original address.
      }
    }
    return css;
  };
  document.querySelectorAll("script, noscript, link[rel=preload], link[rel=modulepreload], link[rel=prefetch], link[rel=preconnect], link[rel=dns-prefetch]").forEach((e) => e.remove());
  for (const link of [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]) {
    try {
      const style = document.createElement("style");
      style.textContent = await inlineUrls(await (await fetch(link.href)).text(), link.href);
      link.replaceWith(style);
    } catch {
      // A stylesheet that cannot be fetched keeps its link.
    }
  }
  for (const style of [...document.querySelectorAll("style")]) style.textContent = await inlineUrls(style.textContent ?? "", location.href);
  for (const el of [...document.querySelectorAll<HTMLElement>("[style*='url(']")]) el.setAttribute("style", await inlineUrls(el.getAttribute("style") ?? "", location.href));
  for (const img of [...document.querySelectorAll("img")]) {
    const src = img.currentSrc || img.src;
    try {
      if (src) img.setAttribute("src", await toData(src));
    } catch {
      // An image that cannot be fetched keeps its address.
    }
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("loading");
  }
  for (const el of [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")]) {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) el.toggleAttribute("checked", el.checked);
    else if (el instanceof HTMLTextAreaElement) el.textContent = el.value;
    else if (el instanceof HTMLSelectElement) [...el.options].forEach((o) => o.toggleAttribute("selected", o.selected));
    else el.setAttribute("value", el.value);
  }
  return "<!doctype html>" + document.documentElement.outerHTML;
}
