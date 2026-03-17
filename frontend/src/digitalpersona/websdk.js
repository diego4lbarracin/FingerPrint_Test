const runtime = globalThis.WebSdk;

if (!runtime || !runtime.WebChannelClient) {
  throw new Error(
    "WebSdk runtime not found. Include websdk.client.bundle.min.js from the DigitalPersona SDK before loading the React app.",
  );
}

export const WebChannelClient = runtime.WebChannelClient;
