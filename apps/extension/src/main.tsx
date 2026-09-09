import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">Tention Reports</p>
      <h1>Monthly Performance Reports</h1>
      <dl>
        <div><dt>Client</dt><dd>Not configured</dd></div>
        <div><dt>Report Month</dt><dd>Not configured</dd></div>
        <div><dt>Status</dt><dd className="ready">Foundation ready</dd></div>
      </dl>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
