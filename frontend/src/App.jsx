import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

function App() {
  const [activeView, setActiveView] = useState("register");
  const [deviceStatus, setDeviceStatus] = useState("Initializing reader...");
  const [captureStatus, setCaptureStatus] = useState("Idle");
  const [lastQuality, setLastQuality] = useState(null);
  const [isAcquiring, setIsAcquiring] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [registerForm, setRegisterForm] = useState({
    name: "",
    lastName: "",
    email: "",
  });
  const [registerFingerprint, setRegisterFingerprint] = useState(null);
  const [registerMessage, setRegisterMessage] = useState("");

  const [authMessage, setAuthMessage] = useState("");
  const [authResult, setAuthResult] = useState(null);

  const readerRef = useRef(null);
  const sdkRef = useRef({ FingerprintReader: null, SampleFormat: null });
  const modeRef = useRef(null);
  const qualityRef = useRef(null);

  const registerReady = useMemo(
    () =>
      registerForm.name &&
      registerForm.lastName &&
      registerForm.email &&
      registerFingerprint,
    [registerForm, registerFingerprint],
  );

  useEffect(() => {
    let isUnmounted = false;
    let reader;
    const initializeReader = async () => {
      try {
        if (!globalThis.WebSdk?.WebChannelClient) {
          throw new Error(
            "DigitalPersona WebSdk runtime not found. Add websdk.client.bundle.min.js to frontend/public.",
          );
        }

        const devicesSdk = globalThis.dp?.devices;
        const FingerprintReader = devicesSdk?.FingerprintReader;
        const SampleFormat = devicesSdk?.SampleFormat;

        if (!FingerprintReader || !SampleFormat) {
          throw new Error(
            "DigitalPersona devices bundle not found. Ensure dp.core.bundle.js and dp.devices.bundle.js are loaded from frontend/public.",
          );
        }

        sdkRef.current = { FingerprintReader, SampleFormat };

        reader = new FingerprintReader();
        if (isUnmounted) return;
        readerRef.current = reader;

        const onDeviceConnected = () => {
          setDeviceStatus("Fingerprint reader connected");
        };

        const onDeviceDisconnected = () => {
          setDeviceStatus("Fingerprint reader disconnected");
          setIsAcquiring(false);
        };

        const onAcquisitionStarted = () => {
          setIsAcquiring(true);
          setCaptureStatus("Reader active. Place your finger on the sensor.");
        };

        const onAcquisitionStopped = () => {
          setIsAcquiring(false);
          setCaptureStatus("Capture stopped");
          modeRef.current = null;
        };

        const onQualityReported = (event) => {
          qualityRef.current = event.quality;
          setLastQuality(event.quality);
        };

        const onErrorOccurred = (event) => {
          setCaptureStatus(`Reader error code: ${event.error}`);
        };

        const onCommunicationFailed = () => {
          setCaptureStatus(
            "Reader communication failed. Ensure DigitalPersona service is running.",
          );
        };

        const onSamplesAcquired = async (event) => {
          const payload = {
            deviceId: event.deviceId,
            sampleFormat: event.sampleFormat,
            quality: qualityRef.current,
            capturedAt: new Date().toISOString(),
            samples: event.samples.map((sample) => ({
              data: sample.Data,
              header: sample.Header,
            })),
          };

          if (modeRef.current === "register") {
            setRegisterFingerprint(payload);
            setRegisterMessage(
              "Fingerprint captured for enrollment. Submit the form to save the user.",
            );
          }

          if (modeRef.current === "authenticate") {
            await authenticate(payload);
          }

          try {
            await reader.stopAcquisition();
          } catch {
            setIsAcquiring(false);
            modeRef.current = null;
          }
        };

        reader.on("DeviceConnected", onDeviceConnected);
        reader.on("DeviceDisconnected", onDeviceDisconnected);
        reader.on("AcquisitionStarted", onAcquisitionStarted);
        reader.on("AcquisitionStopped", onAcquisitionStopped);
        reader.on("QualityReported", onQualityReported);
        reader.on("ErrorOccurred", onErrorOccurred);
        reader.on("CommunicationFailed", onCommunicationFailed);
        reader.on("SamplesAcquired", onSamplesAcquired);

        reader
          .enumerateDevices()
          .then((devices) => {
            if (!devices || devices.length === 0) {
              setDeviceStatus("No fingerprint reader detected");
              return;
            }
            setDeviceStatus(
              `Fingerprint reader ready (${devices.length} detected)`,
            );
          })
          .catch(() => {
            setDeviceStatus(
              "Reader not reachable. Verify the DigitalPersona local service.",
            );
          });
      } catch (error) {
        setDeviceStatus("Fingerprint reader SDK could not initialize.");
        setCaptureStatus(error?.message || "Reader initialization failed");
        // eslint-disable-next-line no-console
        console.error("DigitalPersona SDK initialization error:", error);
      }
    };

    initializeReader();

    return () => {
      isUnmounted = true;
      const cleanup = async () => {
        try {
          if (reader) await reader.stopAcquisition();
        } catch {
          // Reader may already be stopped.
        }
      };

      cleanup();
      if (reader) reader.off();
    };
  }, []);

  const startCapture = async (mode) => {
    const reader = readerRef.current;
    const sampleFormat = sdkRef.current.SampleFormat;
    if (!reader) {
      setCaptureStatus("Reader is not initialized yet");
      return;
    }
    if (!sampleFormat) {
      setCaptureStatus("Fingerprint SDK is not ready yet");
      return;
    }

    setCaptureStatus("Starting acquisition...");
    setAuthMessage("");
    modeRef.current = mode;

    try {
      await reader.startAcquisition(sampleFormat.Intermediate);
    } catch (error) {
      modeRef.current = null;
      setIsAcquiring(false);
      setCaptureStatus(
        `Unable to start acquisition: ${error?.message || "unknown error"}`,
      );
    }
  };

  const handleRegisterInput = (event) => {
    const { name, value } = event.target;
    setRegisterForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  };

  const submitRegistration = async (event) => {
    event.preventDefault();

    if (!registerReady) {
      setRegisterMessage(
        "Fill all fields and capture a fingerprint before saving.",
      );
      return;
    }

    setIsSubmitting(true);
    setRegisterMessage("Saving user...");

    try {
      const response = await fetch(`${API_BASE_URL}/api/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...registerForm,
          fingerprint: registerFingerprint,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Registration failed");
      }

      setRegisterMessage(`User ${data.user.email} registered successfully.`);
      setRegisterForm({ name: "", lastName: "", email: "" });
      setRegisterFingerprint(null);
    } catch (error) {
      setRegisterMessage(`Registration failed: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const authenticate = async (fingerprintPayload) => {
    setIsSubmitting(true);
    setAuthMessage("Authenticating...");
    setAuthResult(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/users/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: fingerprintPayload }),
      });

      const data = await response.json();
      if (!response.ok) {
        if (data.authenticated === false) {
          setAuthResult(data);
          setAuthMessage("No match found for this fingerprint sample.");
          return;
        }
        throw new Error(data.error || data.message || "Authentication failed");
      }

      setAuthResult(data);
      setAuthMessage(`Authenticated: ${data.user.name} ${data.user.lastName}`);
    } catch (error) {
      setAuthMessage(`Authentication failed: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">DigitalPersona U.are.U 4500</p>
        <h1>Fingerprint Registration and Authentication</h1>
        <p className="subtitle">
          Capture fingerprint samples in the browser using the official SDK,
          persist user data in Supabase, and verify incoming samples against
          enrolled templates.
        </p>
      </header>

      <section className="status-panel">
        <div>
          <span className="label">Reader</span>
          <p>{deviceStatus}</p>
        </div>
        <div>
          <span className="label">Capture</span>
          <p>{captureStatus}</p>
        </div>
        <div>
          <span className="label">Quality Code</span>
          <p>{lastQuality ?? "N/A"}</p>
        </div>
      </section>

      <nav className="tabs">
        <button
          type="button"
          className={activeView === "register" ? "tab active" : "tab"}
          onClick={() => setActiveView("register")}
        >
          Create User
        </button>
        <button
          type="button"
          className={activeView === "authenticate" ? "tab active" : "tab"}
          onClick={() => setActiveView("authenticate")}
        >
          Authenticate User
        </button>
      </nav>

      {activeView === "register" && (
        <section className="card">
          <h2>Create an User</h2>
          <form onSubmit={submitRegistration} className="form-grid">
            <label>
              Name
              <input
                name="name"
                value={registerForm.name}
                onChange={handleRegisterInput}
                placeholder="John"
                required
              />
            </label>
            <label>
              Lastname
              <input
                name="lastName"
                value={registerForm.lastName}
                onChange={handleRegisterInput}
                placeholder="Doe"
                required
              />
            </label>
            <label className="full">
              Email
              <input
                type="email"
                name="email"
                value={registerForm.email}
                onChange={handleRegisterInput}
                placeholder="john@company.com"
                required
              />
            </label>
            <div className="actions full">
              <button
                type="button"
                className="secondary"
                onClick={() => startCapture("register")}
                disabled={isAcquiring || isSubmitting}
              >
                {isAcquiring && modeRef.current === "register"
                  ? "Capturing..."
                  : "Capture Fingerprint"}
              </button>
              <button type="submit" disabled={!registerReady || isSubmitting}>
                {isSubmitting ? "Saving..." : "Create User"}
              </button>
            </div>
          </form>
          <p className="hint">
            {registerFingerprint
              ? "Fingerprint sample captured."
              : "No fingerprint sample captured yet."}
          </p>
          {registerMessage && <p className="message">{registerMessage}</p>}
        </section>
      )}

      {activeView === "authenticate" && (
        <section className="card">
          <h2>Authenticate the User</h2>
          <p className="hint">
            Click the button and place a previously enrolled finger on the
            reader.
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => startCapture("authenticate")}
              disabled={isAcquiring || isSubmitting}
            >
              {isAcquiring && modeRef.current === "authenticate"
                ? "Capturing..."
                : "Capture and Authenticate"}
            </button>
          </div>
          {authMessage && <p className="message">{authMessage}</p>}
          {authResult && (
            <div className="result">
              <p>
                Result:{" "}
                <strong>
                  {authResult.authenticated
                    ? "Authenticated"
                    : "Not Authenticated"}
                </strong>
              </p>
              <p>Match Score: {authResult.score}</p>
              <p>Threshold: {authResult.threshold}</p>
              {authResult.user && (
                <p>
                  User: {authResult.user.name} {authResult.user.lastName} (
                  {authResult.user.email})
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
