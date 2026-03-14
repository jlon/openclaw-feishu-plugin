import { describe, expect, it, vi } from "vitest";
import { handleFeishuCommand } from "./feishu-command-handler.js";

describe("handleFeishuCommand", () => {
  it("derives the hook agent id from the session key instead of assuming main", async () => {
    const runBeforeReset = vi.fn(async () => {});

    const handled = await handleFeishuCommand(
      "/reset",
      "agent:dispatcher:feishu:group:oc_group123",
      { runBeforeReset },
      {
        cfg: {},
        sessionEntry: {},
        commandSource: "feishu",
        timestamp: Date.now(),
      },
    );

    expect(handled).toBe(true);
    expect(runBeforeReset).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        agentId: "dispatcher",
        sessionKey: "agent:dispatcher:feishu:group:oc_group123",
      }),
    );
  });
});
