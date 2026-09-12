import { describe, expect, it } from "vitest";
import { APP_NAME, appInfo } from "../src/app-info.js";

describe("appInfo", () => {
  it("reports the application name", () => {
    expect(appInfo().name).toBe(APP_NAME);
    expect(APP_NAME).toBe("za.ai");
  });

  it("exposes a semantic version", () => {
    expect(appInfo().version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
