// Colors come from other clients, so only allow plain hex values into styles.
export const safeColor = (c: string | undefined): string => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
