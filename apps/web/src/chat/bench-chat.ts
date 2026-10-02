/**
 * ADR 0007. Passed as `useChat`'s `sendAutomaticallyWhen`.
 *
 * Harness chat never auto-continues from the last UI step. A finished
 * host tool (`show_artifact`) already ran on the server. Client tools
 * (`get_viewer`, `askUserQuestions`) fill only when this tab calls
 * `sendMessage()` after `addToolOutput`.
 */
export function harnessSendAutomaticallyWhen(_options: {
  messages: readonly unknown[];
}): boolean {
  return false;
}
