import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
// Page adapters reach the shared period helper the extension injects before them (chrome.scripting files).
import "../features/klaviyo-navigation/injected/period-entry.js";
