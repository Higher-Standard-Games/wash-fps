/** Controller intents for document-level match callbacks, independent of DOM key events. */
export const CONTROLLER_MATCH_INPUT = "fps:controller_input";
export interface ControllerMatchInput {
  action: string;
  held: boolean;
  pressed: boolean;
}
