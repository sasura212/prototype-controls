// "Check this screen": the problems a person would hit on what's showing now. Not a full audit: the
// common ones that slip through while a flow is being built, cheap enough to run on every step.

export type Issue = { kind: "name" | "alt" | "label" | "contrast" | "wording"; message: string; selector: string };
/** Words or phrases a project's style guide rules out, with the reason (`script.wording`). */
export type WordingRule = { avoid: string; why: string };

const isShown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/** A selector good enough to find the element again: an id or label if it has one, else its path. */
export const selectorFor = (el: Element): string => {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const label = el.getAttribute("aria-label");
  if (label) return `${el.tagName.toLowerCase()}[aria-label="${label.replace(/"/g, '\\"')}"]`;
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.body && parts.length < 6; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName)
      : [];
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
  }
  return parts.join(" > ");
};

const nameOf = (el: Element) =>
  (
    el.getAttribute("aria-label") ??
    (el.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ") ??
    ""
  ).trim() ||
  (el as HTMLElement).innerText?.trim() ||
  el.getAttribute("title")?.trim() ||
  [...el.querySelectorAll("img[alt]")]
    .map((img) => img.getAttribute("alt"))
    .join(" ")
    .trim();

// Contrast, per WCAG: relative luminance of the text against the first solid background behind it.
const rgb = (color: string): [number, number, number, number] | null => {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const [r, g, b, a = 1] = match[1]
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number);
  return [r, g, b, a];
};
const luminance = ([r, g, b]: number[]) => {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};
/** The first solid colour behind the text, or null when an image or gradient is in the way (can't be judged). */
const backgroundOf = (el: Element | null): number[] | null => {
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage !== "none") return null;
    const color = rgb(style.backgroundColor);
    if (color && color[3] > 0.9) return color;
  }
  return [255, 255, 255, 1];
};

export const audit = (wording: WordingRule[] = [], within: ParentNode = document): Issue[] => {
  const issues: Issue[] = [];
  const add = (kind: Issue["kind"], message: string, el: Element) =>
    issues.push({ kind, message, selector: selectorFor(el) });
  const all = <T extends Element>(selector: string) =>
    [...within.querySelectorAll<T>(selector)].filter((el) => isShown(el) && !el.closest("[data-prototype-overlay]"));

  for (const el of all("button, a[href], [role=button], [role=link], [role=tab], [role=menuitem]"))
    if (!nameOf(el)) add("name", `A ${el.tagName.toLowerCase()} with no name a screen reader can say`, el);
  for (const el of all<HTMLImageElement>("img"))
    if (!el.hasAttribute("alt")) add("alt", `An image with no alt text (${clip(el.src.split("/").pop() ?? "")})`, el);
  for (const el of all<HTMLInputElement>(
    "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"
  ))
    if (!el.labels?.length && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby"))
      add(
        "label",
        `A field with no label${el.placeholder ? ` (only a placeholder: “${clip(el.placeholder)}”)` : ""}`,
        el
      );

  // Text, element by element: contrast, and the style guide's words.
  const texts = all<HTMLElement>("body *").filter((el) =>
    [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
  );
  for (const el of texts.slice(0, 400)) {
    const style = getComputedStyle(el);
    const fg = rgb(style.color);
    // Disabled controls are exempt from contrast rules, and usually fade on purpose.
    const isDisabled = Boolean(el.closest(":disabled, [aria-disabled=true]"));
    if (fg && fg[3] > 0.5 && !isDisabled) {
      const behind = backgroundOf(el);
      if (!behind) continue;
      const [a, b] = [luminance(fg), luminance(behind)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(style.fontSize);
      const isLarge = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (isLarge ? 3 : 4.5))
        add("contrast", `Low contrast (${ratio.toFixed(1)}:1) on “${clip(el.innerText.trim())}”`, el);
    }
    const own = [...el.childNodes].map((node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : "")).join(" ");
    for (const rule of wording)
      if (own.toLowerCase().includes(rule.avoid.toLowerCase()))
        add("wording", `“${rule.avoid}” in “${clip(own.trim())}”: ${rule.why}`, el);
  }
  return issues;
};
