/** True when a CSS media query matches (false where matchMedia is unavailable). One copy for the host, the title screen and Free Roam. */
export const mediaMatches = (query: string): boolean => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
