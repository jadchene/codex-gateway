import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { AppProviders } from "./app/providers";
import "./app/styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("Renderer root element is missing.");

createRoot(container).render(
  <React.StrictMode>
    <HashRouter>
      <AppProviders>
        <App />
      </AppProviders>
    </HashRouter>
  </React.StrictMode>
);
