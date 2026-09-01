import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  // lucide-react is a barrel of thousands of icon modules. Left to discover them
  // lazily, Vite re-optimizes the moment a route imports a new icon, and every page
  // already open 504s on its client bundle and silently stops hydrating — the app
  // renders but nothing is clickable. Pre-bundling it up front removes that class of
  // "I clicked and nothing happened" entirely.
  optimizeDeps: {
    include: ["lucide-react"],
  },
});
