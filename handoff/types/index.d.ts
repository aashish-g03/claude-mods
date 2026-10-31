export type Phase =
  | 'hidden'
  | 'ready'
  | 'working'
  | 'done'
  | 'failed'
  | 'waiting'
  | 'stale'
  | 'resumed'

export type Band = {
  phase: Phase
  percent?: number
  at?: number
  pending?: number
  note?: string
  // The fill when Later was pressed; the button returns 5 points on.
  dismissedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { band: Shaped<Band> }
  }
}
