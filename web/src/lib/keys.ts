// Label for the platform's command modifier in shortcut hints.
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl";

/** True when a keyboard event happened inside something that takes text or owns its keys. */
export const isTypingTarget = (e: KeyboardEvent) =>
  !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog], [role=listbox]");
