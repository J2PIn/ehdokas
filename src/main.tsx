import React from "react";
import ReactDOM from "react-dom/client";
import "./ehdokas.css";
import Home from "./pages/Home";
import Disclose from "./pages/Disclose";
import Verify from "./pages/Verify";

function route(): "home" | "disclose" | "verify" {
  const p = window.location.pathname;

  if (p === "/disclose") return "disclose";
  if (p === "/verify") return "verify";
  return "home";
}

function App() {
  const [r, setR] = React.useState<"home" | "disclose" | "verify">(route());

  React.useEffect(() => {
    const onPop = () => setR(route());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (r === "disclose") return <Disclose />;
  if (r === "verify") return <Verify />;
  return <Home />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
