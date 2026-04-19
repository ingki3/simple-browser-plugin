import React from "react";
import ReactDOM from "react-dom/client";
import { Options } from "./Options";
import "../sidepanel/styles.css";
import "./options.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);
