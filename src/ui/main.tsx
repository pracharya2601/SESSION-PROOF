import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readTheme } from "./shell/theme";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/design.css";
import "./styles/shell.css";
import "./styles/today.css";

applyTheme(readTheme());

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
