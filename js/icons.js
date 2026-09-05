// Icons are <symbol>s in the inline SVG sprite at the top of index.html
// (Font Awesome Free 6.4.0, CC BY 4.0). Returns the markup for one icon.
export function icon(name, extraClass = "") {
  const cls = `icon icon-${name}${extraClass ? ` ${extraClass}` : ""}`;
  return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}
