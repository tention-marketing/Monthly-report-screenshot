import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app/App.js";
import { apiClient } from "./lib/api/client.js";

createRoot(document.getElementById("root")!).render(<StrictMode><App api={apiClient} /></StrictMode>);
