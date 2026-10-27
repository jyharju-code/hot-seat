import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/archivo";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/700.css";
import "./styles/global.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
