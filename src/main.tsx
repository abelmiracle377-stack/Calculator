import "@/lib/pwa";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "@/lib/superdev/client";

createRoot(document.getElementById("root")!).render(<App />);
