import { botschatPlugin } from "./src/channel.js";
import { setBotsChatRuntime } from "./src/runtime.js";

// OpenClaw Plugin Definition
// This is the entry point loaded by OpenClaw's plugin system.
// It registers the BotsChat channel plugin.
const plugin = {
  id: "botschat",
  name: "BotsChat",
  description: "Connect to BotsChat cloud chat platform",
  configSchema: { safeParse: () => ({ success: true }) },
  register(api: {
    runtime: unknown;
    registerChannel: (reg: { plugin: typeof botschatPlugin }) => void;
  }) {
    setBotsChatRuntime(api.runtime);
    api.registerChannel({ plugin: botschatPlugin });
  },
};

export default plugin;
