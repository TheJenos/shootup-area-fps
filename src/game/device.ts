/**
 * Phones and tablets get touch controls. `?touch` in the URL forces them on, for trying the
 * layout with a mouse on a desktop.
 */
export const TOUCH = new URLSearchParams(window.location.search).has('touch')
  || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
