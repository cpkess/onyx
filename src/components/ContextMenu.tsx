import { useEffect } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    // Defer so the opening click/contextmenu doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("blur", close);
    }, 0);
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      className="fixed z-[60] min-w-[12rem] overflow-hidden rounded-md border border-black/10 bg-white py-1 text-sm shadow-xl dark:border-white/10 dark:bg-neutral-800"
      style={{ top: menu.y, left: menu.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`block w-full px-3 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10 ${
            item.danger
              ? "text-red-500"
              : "text-neutral-700 dark:text-neutral-200"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
