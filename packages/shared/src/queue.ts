import { DeliveryMode, QueuedInstruction } from "./protocol";

export interface CommandQueueState {
  items: QueuedInstruction[];
}

export function enqueueInstruction(
  state: CommandQueueState,
  item: QueuedInstruction,
  mode: DeliveryMode
): { next: CommandQueueState; interrupted: boolean } {
  if (state.items.length >= 100) throw new Error("Queue is full (100 instructions); wait for a task to finish");
  if (mode === "interrupt") {
    return {
      next: { items: [item, ...state.items] },
      interrupted: true,
    };
  }
  return {
    next: { items: [...state.items, item] },
    interrupted: false,
  };
}

export function dequeueInstruction(
  state: CommandQueueState
): { next: CommandQueueState; item: QueuedInstruction | null } {
  if (state.items.length === 0) {
    return { next: state, item: null };
  }
  const [item, ...rest] = state.items;
  return { next: { items: rest }, item };
}
