import { useSyncExternalStore } from "react";

export type SelectionState = { selected: string | null; hovered: string | null; /** The room key the camera and the list are focused on. */ room: string | null };

/** Which agent is selected and which is under the pointer. One store shared by the list and the scene. */
export function createSelection() {
  let state: SelectionState = { selected: null, hovered: null, room: null };
  const listeners = new Set<() => void>();
  const set = (next: SelectionState) => {
    if (next.selected === state.selected && next.hovered === state.hovered && next.room === state.room) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    select: (id: string | null) => set({ ...state, selected: id }),
    hover: (id: string | null) => set({ ...state, hovered: id }),
    focusRoom: (key: string | null) => set({ ...state, room: key }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type Selection = ReturnType<typeof createSelection>;

export const selection: Selection = createSelection();

export function useSelection(store: Selection = selection): SelectionState {
  return useSyncExternalStore(store.subscribe, store.get);
}
