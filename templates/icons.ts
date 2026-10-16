// The player's icons: one stroke weight, 16px, drawn in currentColor so they take the button's colour.
const svg = (body: string, fill = false) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  play: svg(`<path d="M7 4.5v15l12.5-7.5z"/>`, true),
  pause: svg(
    `<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>`,
    true
  ),
  prev: svg(`<path d="M18 5v14L8 12z" fill="currentColor"/><path d="M6 5v14"/>`),
  next: svg(`<path d="M6 5v14l10-7z" fill="currentColor"/><path d="M18 5v14"/>`),
  replay: svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>`),
  comment: svg(`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>`),
  settings: svg(
    `<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`
  ),
  minimize: svg(`<path d="M5 12h14"/>`),
  grip: svg(
    `<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>`,
    true
  ),
  close: svg(`<path d="M6 6l12 12M18 6L6 18"/>`),
  check: svg(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
  reopen: svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>`),
  send: svg(`<path d="M12 19V5M5 12l7-7 7 7"/>`),
  studio: svg(`<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>`),
};
