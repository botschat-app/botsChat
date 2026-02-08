// Holds the PluginRuntime reference injected by OpenClaw at registration time.
// All channel code should access runtime through getBotsChatRuntime().

// We use `any` here because the concrete type comes from openclaw internals
// and we only access it via the plugin SDK's public surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _runtime: any | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setBotsChatRuntime(runtime: any): void {
  _runtime = runtime;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBotsChatRuntime(): any {
  if (!_runtime) {
    throw new Error("BotsChat runtime not initialized — plugin not registered yet");
  }
  return _runtime;
}
