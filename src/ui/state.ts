export interface SelectionState {
  streamId: string;
  weatherId: string;
  presetIndex: number;
  sectionCount: number;
}

export const DEFAULT_SELECTION: SelectionState = {
  streamId: 'jiuqu',
  weatherId: 'spring',
  presetIndex: 1,
  sectionCount: 30,
};
