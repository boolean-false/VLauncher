import { useRef, type SelectHTMLAttributes } from "react";
import { popupMenu } from "../desktop";

// Системный список Tauri иногда зависает после потери фокуса на Linux.
const useTauriPopup = !navigator.platform.toLowerCase().includes("linux");

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const ref = useRef<HTMLSelectElement>(null);
  const showOptions = () => {
    const select = ref.current;
    if (!select || select.matches(":disabled")) return;
    select.focus({ preventScroll: true });
    const rect = select.getBoundingClientRect();
    void popupMenu(Array.from(select.options).map((option) => ({
      text: option.label,
      checked: option.selected,
      enabled: !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      action: () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
    })), { x: rect.left, y: rect.bottom });
  };
  return <select
    {...props}
    ref={ref}
    onMouseDown={(event) => {
      props.onMouseDown?.(event);
      if (useTauriPopup && !event.defaultPrevented && event.button === 0) {
        event.preventDefault();
        showOptions();
      }
    }}
    onKeyDown={(event) => {
      props.onKeyDown?.(event);
      if (useTauriPopup && !event.defaultPrevented && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        showOptions();
      }
    }}
  />;
}
