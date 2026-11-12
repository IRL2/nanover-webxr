// Shared model for server-defined custom UI panels (state keys panel.*,
// with slider values stored under variable.*). rendered by xrCustomUI.ts and webUI.ts.

const PANEL_PREFIX = 'panel.';
const VARIABLE_PREFIX = 'variable.';

export type CustomPanelElement =
  | { type: 'header'; label: string }
  | { type: 'button'; label: string; command: string; arguments: Record<string, unknown> }
  | {
      type: 'slider';
      label: string;
      variable: string;
      min: number;
      max: number;
      integer: boolean;
      step?: number;
    };

export interface CustomPanel {
  key: string;
  label: string;
  elements: CustomPanelElement[];
}

export type CustomUIChange = 'panels' | 'variables';

interface CustomUIContext {
  runCommand: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  publishSharedState: (updates: Record<string, unknown>) => void;
}

const panels = new Map<string, CustomPanel>();
const variables = new Map<string, unknown>();
const listeners = new Set<(change: CustomUIChange) => void>();
let context: CustomUIContext | undefined;

export function configureCustomUI(ctx: CustomUIContext) {
  context = ctx;
}

export function subscribeCustomUI(listener: (change: CustomUIChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(change: CustomUIChange) {
  for (const listener of listeners) {
    listener(change);
  }
}

export function getCustomPanels(): CustomPanel[] {
  return [...panels.values()];
}

export function resetCustomUI() {
  const hadPanels = panels.size > 0;
  panels.clear();
  variables.clear();
  if (hadPanels) {
    emit('panels');
  }
}

function parseElement(raw: unknown): CustomPanelElement | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const element = raw as Record<string, unknown>;
  const label = typeof element.label === 'string' ? element.label : '';

  switch (element.type) {
    case 'header':
      return { type: 'header', label };
    case 'button': {
      if (typeof element.command !== 'string') {
        return null;
      }
      const args = element.arguments;
      return {
        type: 'button',
        label,
        command: element.command,
        arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      };
    }
    case 'slider': {
      if (typeof element.variable !== 'string') {
        return null;
      }
      const range = Array.isArray(element.range) ? element.range : [0, 1];
      const min = Number(range[0] ?? 0);
      const max = Number(range[1] ?? 1);
      const step = typeof element.step === 'number' && element.step > 0 ? element.step : undefined;
      return {
        type: 'slider',
        label,
        variable: element.variable,
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 1,
        integer: element.integer === true,
        step,
      };
    }
    default:
      return null;
  }
}

function parsePanel(key: string, raw: unknown): CustomPanel | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const elements = Array.isArray(value.elements)
    ? value.elements.map(parseElement).filter((e): e is CustomPanelElement => e !== null)
    : [];
  return {
    key,
    label: typeof value.label === 'string' ? value.label : key,
    elements,
  };
}

export function applyCustomUIState(updates?: Record<string, unknown>, removals?: string[]) {
  let panelsChanged = false;
  let variablesChanged = false;

  for (const [key, value] of Object.entries(updates ?? {})) {
    if (key.startsWith(PANEL_PREFIX)) {
      const panelKey = key.slice(PANEL_PREFIX.length);
      const panel = parsePanel(panelKey, value);
      if (panel) {
        panels.set(panelKey, panel);
        panelsChanged = true;
      }
    } else if (key.startsWith(VARIABLE_PREFIX)) {
      variables.set(key, value);
      variablesChanged = true;
    }
  }

  for (const key of removals ?? []) {
    if (key.startsWith(PANEL_PREFIX)) {
      panelsChanged = panels.delete(key.slice(PANEL_PREFIX.length)) || panelsChanged;
    } else if (key.startsWith(VARIABLE_PREFIX)) {
      variablesChanged = variables.delete(key) || variablesChanged;
    }
  }

  if (panelsChanged) emit('panels');
  if (variablesChanged) emit('variables');
}

function sliderFor(variable: string): CustomPanelElement | undefined {
  for (const panel of panels.values()) {
    for (const element of panel.elements) {
      if (element.type === 'slider' && element.variable === variable) {
        return element;
      }
    }
  }
  return undefined;
}

// variables never set by anyone default to their slider's minimum
export function getVariable(variable: string): unknown {
  if (variables.has(variable)) {
    return variables.get(variable);
  }
  const slider = sliderFor(variable);
  return slider && slider.type === 'slider' ? slider.min : undefined;
}

export function setVariable(variable: string, value: number) {
  if (variables.get(variable) === value) {
    return;
  }
  variables.set(variable, value);
  context?.publishSharedState({ [variable]: value });
  emit('variables');
}

function resolveArguments(args: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).variable === 'string') {
      resolved[name] = getVariable((value as { variable: string }).variable);
    } else {
      resolved[name] = value;
    }
  }
  return resolved;
}

export function runPanelCommand(command: string, args: Record<string, unknown>) {
  return context?.runCommand(command, resolveArguments(args));
}

export function formatSliderValue(element: { integer: boolean }, value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return element.integer ? String(Math.round(n)) : String(Number(n.toFixed(3)));
}
