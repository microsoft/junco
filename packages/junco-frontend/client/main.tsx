import "@syncfusion/ej2-material3-theme/styles/kanban/index.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html lacks #root");
createRoot(root).render(<App />);
