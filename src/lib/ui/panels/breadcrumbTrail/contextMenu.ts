// Shared in-shadow context menu shell for the trail overlay.

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface ContextMenuDetail {
  title: string;
  subtitle?: string;
  meta?: string;
}

export interface ShowContextMenuOptions {
  layer: HTMLElement;
  anchor: HTMLElement;
  trigger?: HTMLElement | null;
  detail: ContextMenuDetail;
  items: ContextMenuItem[];
  /** Keyboard invocation moves focus into the menu; pointer invocation does not. */
  focusOnOpen?: boolean;
  onClose: () => void;
}

export interface ContextMenuHandle {
  element: HTMLDivElement;
  close: () => void;
}

let nextMenuId = 0;

export function showContextMenu(options: ShowContextMenuOptions): ContextMenuHandle {
  const menuId = `tabtrail-context-menu-${++nextMenuId}`;
  const menu = document.createElement("div");
  menu.id = menuId;
  menu.className = "wf-menu";
  menu.dataset.tabtrailHitSurface = "";
  menu.dataset.tabtrailScrollRegion = "";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const detail = document.createElement("div");
  detail.className = "wf-menu-detail";
  detail.setAttribute("role", "presentation");

  const title = document.createElement("div");
  title.id = `${menuId}-title`;
  title.className = "wf-menu-detail-title";
  title.textContent = options.detail.title;
  detail.appendChild(title);
  menu.setAttribute("aria-labelledby", title.id);

  const descriptionIds: string[] = [];

  if (options.detail.subtitle) {
    const subtitle = document.createElement("div");
    subtitle.id = `${menuId}-subtitle`;
    subtitle.className = "wf-menu-detail-url";
    subtitle.textContent = options.detail.subtitle;
    detail.appendChild(subtitle);
    descriptionIds.push(subtitle.id);
  }

  if (options.detail.meta) {
    const meta = document.createElement("div");
    meta.id = `${menuId}-meta`;
    meta.className = "wf-menu-detail-time";
    meta.textContent = options.detail.meta;
    detail.appendChild(meta);
    descriptionIds.push(meta.id);
  }

  if (descriptionIds.length > 0) {
    menu.setAttribute("aria-describedby", descriptionIds.join(" "));
  }

  menu.appendChild(detail);

  const actions = document.createElement("div");
  actions.className = "wf-menu-actions";
  actions.setAttribute("role", "presentation");
  const itemButtons: HTMLButtonElement[] = [];
  for (const item of options.items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "wf-menu-item";
    row.setAttribute("role", "menuitem");
    row.textContent = item.label;
    row.disabled = item.disabled === true;
    row.tabIndex = -1;
    if (item.danger) {
      row.classList.add("wf-menu-item-danger");
      row.dataset.danger = "true";
    }
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      // Native button activation reports detail 0 for keyboard input. Restore
      // the opener in that case, but let pointer activation keep its own focus.
      closeMenu(event.detail === 0);
      item.action();
    });
    actions.appendChild(row);
    itemButtons.push(row);
  }
  menu.appendChild(actions);
  options.layer.appendChild(menu);
  const reposition = (): void => positionPopover(menu, options.anchor);
  reposition();
  window.addEventListener("resize", reposition);

  if (options.trigger) {
    options.trigger.setAttribute("aria-haspopup", "menu");
    options.trigger.setAttribute("aria-expanded", "true");
    options.trigger.setAttribute("aria-controls", menuId);
  }

  let closed = false;
  const closeMenu = (restoreFocus: boolean): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    window.removeEventListener("resize", reposition);
    menu.remove();

    if (options.trigger) {
      options.trigger.setAttribute("aria-expanded", "false");
      options.trigger.removeAttribute("aria-controls");
    }

    try {
      options.onClose();
    } finally {
      if (
        restoreFocus &&
        options.trigger?.isConnected &&
        !options.trigger.matches(":disabled")
      ) {
        options.trigger.focus({ preventScroll: true });
      }
    }
  };

  const onOutsidePointer = (event: Event): void => {
    const path = event.composedPath();
    if (path.includes(menu)) return;
    if (options.trigger && path.includes(options.trigger)) return;
    closeMenu(false);
  };
  document.addEventListener("pointerdown", onOutsidePointer, true);

  const enabledItems = (): HTMLButtonElement[] => itemButtons.filter((item) => !item.disabled);
  const focusItem = (item: HTMLButtonElement): void => {
    for (const candidate of itemButtons) candidate.tabIndex = candidate === item ? 0 : -1;
    item.focus({ preventScroll: true });
    // `preventScroll` keeps the host page still, but it also suppresses the
    // menu's own automatic scrolling. Reveal roving-focus targets explicitly.
    item.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  menu.addEventListener("keydown", (event) => {
    const items = enabledItems();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }

    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.indexOf(event.target as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else {
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    }
    const next = items[nextIndex];
    if (next) focusItem(next);
  });

  const firstItem = enabledItems()[0];
  if (options.focusOnOpen !== false) {
    if (firstItem) focusItem(firstItem);
    else menu.focus({ preventScroll: true });
  }

  const menuHasFocus = (): boolean => {
    const root = menu.getRootNode();
    const active = "activeElement" in root
      ? (root as Document | ShadowRoot).activeElement
      : document.activeElement;
    return active instanceof HTMLElement && menu.contains(active);
  };

  return { element: menu, close: () => closeMenu(menuHasFocus()) };
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const gap = 6;
  const anchorRect = anchor.getBoundingClientRect();
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popoverRect = popover.getBoundingClientRect();
  const width = popoverRect.width || 240;
  // CSS constrains the rendered menu to this height. Cap the measurement too
  // so positioning remains correct while styles are loading and in DOM tests.
  const height = Math.min(popoverRect.height, Math.max(0, window.innerHeight - margin * 2));
  const left = Math.min(
    Math.max(margin, anchorRect.left),
    Math.max(margin, window.innerWidth - width - margin),
  );
  let top = anchorRect.bottom + gap;
  if (top + height > window.innerHeight - margin) {
    top = anchorRect.top - height - gap;
  }
  top = Math.min(
    Math.max(margin, top),
    Math.max(margin, window.innerHeight - height - margin),
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}
