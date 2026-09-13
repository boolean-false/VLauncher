import { invoke } from "@tauri-apps/api/core";
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";

let currentMenu: Menu | undefined;
export async function popupMenu(items: NonNullable<MenuOptions["items"]>, at: { x: number; y: number }) {
  try {
    await currentMenu?.close();
    currentMenu = await Menu.new({ items });
    // На Wayland меню нужно привязать к окну.
    const [x, y] = await invoke<[number, number]>("popup_menu_position", at);
    await currentMenu.popup(new LogicalPosition(x, y), getCurrentWindow());
  } catch (error) {
    console.error("Не удалось открыть меню приложения", error);
  }
}

export function contextMenuPosition(event: {clientX: number; clientY: number; target: EventTarget | null}) {
  if (event.clientX || event.clientY) return {x: event.clientX, y: event.clientY};
  const element = event.target instanceof Element ? event.target : document.activeElement;
  const rect = element?.getBoundingClientRect();
  return {x: rect ? rect.left + 8 : 8, y: rect ? Math.min(rect.bottom, innerHeight - 8) : 8};
}

function editable(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  return target instanceof Element ? target.closest("input, textarea") : null;
}
const linux = navigator.platform.toLowerCase().includes("linux");
async function edit(command: string) {
  // Готовые пункты GTK не работают на Wayland.
  try { await invoke("edit_text", { command }); }
  catch (error) { console.error("Не удалось выполнить команду редактирования", error); }
}

export function installDesktopBehavior() {
  const root = document.documentElement;
  root.dataset.inputMode = "pointer";
  const pointer = () => { root.dataset.inputMode = "pointer"; };
  const key = (event: KeyboardEvent) => {
    // Подсветка фокуса нужна только при навигации через Tab.
    if (event.key === "Tab") root.dataset.inputMode = "keyboard";
    const text = editable(event.target);
    const command = event.ctrlKey || event.metaKey;
    if (event.key === "F7" || event.key === "F5" ||
        (command && ["r", "l", "p", "s", "u", "o"].includes(event.key.toLowerCase())) ||
        (event.altKey && ["ArrowLeft", "ArrowRight", "Home"].includes(event.key))) {
      event.preventDefault();
    }
    if (!text && command && event.key.toLowerCase() === "a") {
      const block = event.target instanceof Element ? event.target.closest(".selectable, .log-view") : null;
      event.preventDefault();
      if (block) selectText(block);
    }
    if (!text && event.key.startsWith("Arrow") && !(event.target instanceof HTMLSelectElement)
      && !(event.target instanceof Element && event.target.closest('[role="listbox"], [role="combobox"], [role="menu"]'))) {
      // Стрелки не должны перескакивать между элементами страницы.
      event.preventDefault();
    }
  };
  const context = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const field = editable(event.target);
    const at = contextMenuPosition(event);
    if (field && !field.disabled) {
      field.focus({ preventScroll: true });
      const writable = !field.readOnly;
      if (!linux) {
        const items: NonNullable<MenuOptions["items"]> = [];
        if (writable) items.push({item:"Undo",text:"Отменить"}, {item:"Redo",text:"Повторить"}, {item:"Separator"});
        if (writable && field.type !== "password") items.push({item:"Cut",text:"Вырезать"});
        if (field.type !== "password") items.push({item:"Copy",text:"Копировать"});
        if (writable) items.push({item:"Paste",text:"Вставить"});
        items.push({item:"Separator"}, {item:"SelectAll",text:"Выделить всё"});
        void popupMenu(items, at);
        return;
      }
      void popupMenu([
        { text: "Отменить", enabled: writable, action: () => { void edit("Undo"); } },
        { text: "Повторить", enabled: writable, action: () => { void edit("Redo"); } },
        { item: "Separator" },
        { text: "Вырезать", enabled: writable && field.type !== "password", action: () => { void edit("Cut"); } },
        { text: "Копировать", enabled: field.type !== "password", action: () => { void edit("Copy"); } },
        { text: "Вставить", enabled: writable, action: () => { void edit("Paste"); } },
        { item: "Separator" },
        { text: "Выделить всё", action: () => field.select() },
      ], at);
      return;
    }
    const block = event.target instanceof Element ? event.target.closest(".selectable, .log-view") : null;
    if (block) {
      if (!linux) {
        if (!window.getSelection()?.toString()) selectText(block);
        void popupMenu([{item:"Copy",text:"Копировать"}, {text:"Выделить текст",action:()=>selectText(block)}], at);
        return;
      }
      void popupMenu([
        { text: "Копировать", action: () => {
          if (!window.getSelection()?.toString()) selectText(block);
          void edit("Copy");
        } },
        { text: "Выделить текст", action: () => selectText(block) },
      ], at);
    }
  };
  const drag = (event: DragEvent) => { if (!editable(event.target)) event.preventDefault(); };
  const drop = (event: DragEvent) => { event.preventDefault(); };
  const wheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("contextmenu", context);
  document.addEventListener("dragstart", drag);
  document.addEventListener("dragover", drop);
  document.addEventListener("drop", drop);
  document.addEventListener("wheel", wheel, { passive: false });
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("contextmenu", context);
    document.removeEventListener("dragstart", drag);
    document.removeEventListener("dragover", drop);
    document.removeEventListener("drop", drop);
    document.removeEventListener("wheel", wheel);
    void currentMenu?.close();
  };
}
function selectText(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}
