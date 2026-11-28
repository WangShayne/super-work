/** Pure state helpers for the Home composer's starter chips (toggle / switch / cancel / clear). */

export type StarterId = "bug" | "feature" | "refactor" | "release";

export interface StarterComposerState {
  text: string;
  activeStarter: StarterId | null;
  releaseMode: boolean;
  version: string;
  milestoneTitle: string;
  optionsOpen: boolean;
  /** True when scope/model/budget options hold user input, so the options panel must stay open. */
  hasCustomOptions: boolean;
}

export type StarterComposerAction =
  | { type: "toggle"; id: StarterId; scaffold: string }
  | { type: "clear" }
  | { type: "text"; value: string }
  | { type: "release_checkbox"; checked: boolean }
  | { type: "version"; value: string }
  | { type: "milestone_title"; value: string }
  | { type: "options_open"; value: boolean }
  | { type: "custom_options"; value: boolean };

export const INITIAL_STARTER_STATE: StarterComposerState = {
  text: "",
  activeStarter: null,
  releaseMode: false,
  version: "",
  milestoneTitle: "",
  optionsOpen: false,
  hasCustomOptions: false,
};

/** True when the text is empty, an untouched starter scaffold, or only bullet/whitespace filler. */
export function isScaffoldOnlyText(text: string, scaffolds: readonly string[]): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (scaffolds.some((s) => s.trim() === trimmed)) return true;
  return text.replace(/[-*\s]/g, "") === "";
}

function resetRelease(state: StarterComposerState): StarterComposerState {
  return {
    ...state,
    releaseMode: false,
    version: "",
    milestoneTitle: "",
    optionsOpen: state.hasCustomOptions ? state.optionsOpen : false,
  };
}

export function reduceStarterComposer(
  state: StarterComposerState,
  action: StarterComposerAction,
  allScaffolds: readonly string[],
): StarterComposerState {
  switch (action.type) {
    case "toggle": {
      const { id, scaffold } = action;
      if (state.activeStarter === id) {
        const next: StarterComposerState = {
          ...state,
          activeStarter: null,
          text: isScaffoldOnlyText(state.text, allScaffolds) ? "" : state.text,
        };
        return id === "release" || state.releaseMode ? resetRelease(next) : next;
      }
      let next: StarterComposerState = {
        ...state,
        activeStarter: id,
        text: isScaffoldOnlyText(state.text, allScaffolds) ? scaffold : `${scaffold}\n\n${state.text}`,
      };
      if (id === "release") {
        next = { ...next, releaseMode: true, optionsOpen: true };
      } else if (state.releaseMode) {
        next = resetRelease(next);
      }
      return next;
    }
    case "clear":
      return resetRelease({ ...state, text: "", activeStarter: null });
    case "text":
      return {
        ...state,
        text: action.value,
        activeStarter:
          action.value.trim() === "" && state.activeStarter !== "release" ? null : state.activeStarter,
      };
    case "release_checkbox": {
      if (action.checked) return { ...state, releaseMode: true };
      const next: StarterComposerState = { ...state, releaseMode: false, version: "", milestoneTitle: "" };
      if (state.activeStarter !== "release") return next;
      return {
        ...next,
        activeStarter: null,
        text: isScaffoldOnlyText(state.text, allScaffolds) ? "" : state.text,
      };
    }
    case "version":
      return { ...state, version: action.value };
    case "milestone_title":
      return { ...state, milestoneTitle: action.value };
    case "options_open":
      return { ...state, optionsOpen: action.value };
    case "custom_options":
      return state.hasCustomOptions === action.value ? state : { ...state, hasCustomOptions: action.value };
  }
}
