import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        "server/index": "src/server/index.ts",
        "client/index": "src/client/index.ts",
        "llm/index": "src/llm/index.ts",
        "node/index": "src/node/index.ts",
    },
    format: ["esm"],
    dts: true,           // génère les .d.ts
    sourcemap: true,
    clean: true,
    target: "node20",
    outDir: "dist",
    splitting: false,    // un fichier par entrée, pas de chunks partagés
    treeshake: true,
});