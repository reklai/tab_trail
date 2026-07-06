// Shared settings-control population used by both the toolbar popup and the
// options page, so the two surfaces always render the same option lists from the
// same contract arrays.

import { formatWayfindModifierKey, WAYFIND_MODIFIER_KEYS } from "../../common/contracts/wayfind";

export function populateModifierSelect(
  select: HTMLSelectElement,
  selected: WayfindModifierKey,
): void {
  select.textContent = "";
  for (const modifier of WAYFIND_MODIFIER_KEYS) {
    const option = document.createElement("option");
    option.value = modifier;
    option.textContent = formatWayfindModifierKey(modifier);
    if (modifier === selected) option.selected = true;
    select.appendChild(option);
  }
}
