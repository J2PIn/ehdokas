import React from "react";
import ReactDOM from "react-dom/client";
import "./ehdokas.css";
import Home from "./pages/Home";
import Disclose from "./pages/Disclose";

function route() {
  const h = window.location.hash || "#/";
  if (h.startsWith("#/disclose")) return "disclose";
  return "home";
}

function App() {
  const [r, setR] = React.useState(route());

  React.useEffect(() => {
    const onHash = () => setR(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return r === "disclose" ? <Disclose /> : <Home />;
}


ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
