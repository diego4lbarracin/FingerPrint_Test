import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

const root = createRoot(document.getElementById("root"));

const sdkFiles = [
  "websdk.client.bundle.min.js",
  "websdk.compat.js",
  "dp.core.bundle.js",
  "dp.devices.bundle.js",
];

const ensureTrailingSlash = (value) =>
  value.endsWith("/") ? value : `${value}/`;

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });

const bootstrap = async () => {
  const base = ensureTrailingSlash(import.meta.env.BASE_URL || "/");

  try {
    for (const file of sdkFiles) {
      await loadScript(`${base}${file}`);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("DigitalPersona runtime could not be loaded:", error);
  }

  root.render(<App />);
};

bootstrap();
