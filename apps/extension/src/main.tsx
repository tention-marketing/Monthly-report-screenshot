import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app/App.js";
import { apiClient } from "./lib/api/client.js";
import { ChromeCaptureService } from "./features/screenshot-capture/capture-service.js";
import { ChromeKlaviyoNavigationService } from "./features/klaviyo-navigation/navigation-service.js";
import { ChromeAutoCaptureService } from "./features/automatic-capture/auto-capture-service.js";

createRoot(document.getElementById("root")!).render(<StrictMode><App api={apiClient} captureService={new ChromeCaptureService()} navigationService={new ChromeKlaviyoNavigationService()} automaticCaptureService={new ChromeAutoCaptureService()} /></StrictMode>);
