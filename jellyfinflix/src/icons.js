// Simple line icons drawn for JellyfinFlix (24x24 viewBox).
const svg = (d, fill) => '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="' + (fill ? 'currentColor' : 'none') +
  '" stroke="currentColor" stroke-width="' + (fill ? 0 : 2.2) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

export const ICON = {
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>'),
  shows: svg('<rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M8 2.5l4 3.5 4-3.5"/>'),
  movies: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  list: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M4.5 12.5l5 5 10-11"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5z"/>', true),
  pause: svg('<path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/>', true),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  user: svg('<circle cx="12" cy="8.5" r="4"/><path d="M4 21c1.2-4.2 4.3-6 8-6s6.8 1.8 8 6"/>'),
  restart: svg('<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5"/>'),
  audio: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h4M7 14h10M13 10h4"/>'),
  next: svg('<path d="M5 5v14l10-7zM18 5v14"/>'),
  wrench: svg('<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/>'),
  rew10: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v3.7h3.7"/><text x="12.3" y="15.6" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial,sans-serif">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v3.7h-3.7"/><text x="11.7" y="15.6" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial,sans-serif">10</text></svg>',
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>', true),
  del: svg('<path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/>'),
  ff: svg('<path d="M3 5.5v13l8.5-6.5zM12.5 5.5v13L21 12z"/>', true),
  episodes: svg('<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M6 5.5h12M8.5 2.5h7"/>'),
  sub: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h3M12 15h5M7 11h10"/>'),
};
