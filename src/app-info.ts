/** Application metadata, surfaced via /healthz and the CLI. */
export const APP_NAME = "za.ai";
export const APP_DESCRIPTION = "Self-hostable AI assistant service";

export function appInfo() {
  return {
    name: APP_NAME,
    description: APP_DESCRIPTION,
    version: "0.1.0",
  };
}
