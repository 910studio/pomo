import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: it double-invokes effects in dev, which would spin up two timers.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
