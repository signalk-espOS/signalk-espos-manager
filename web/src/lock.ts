/**
 * Props for an action's button: disabled, with the reason as a tooltip, on a
 * demo server. The server refuses the action either way; this only saves a
 * visitor the click.
 */

import { DEMO_TITLE } from "./api.js";
import { useStore } from "./store.js";

export function useLock(): (disabled?: boolean) => {
  disabled: boolean;
  title?: string;
} {
  const readOnly = useStore((state) => state.readOnly);
  return (disabled = false) =>
    readOnly ? { disabled: true, title: DEMO_TITLE } : { disabled };
}
