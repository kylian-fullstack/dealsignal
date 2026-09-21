import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const store = new FileStore(resolve("data", "store.json"));
const app = createApp(store);
const distributionPath = resolve("dist");

if (existsSync(distributionPath)) {
  app.use(express.static(distributionPath, { index: false }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) =>
    response.sendFile(resolve(distributionPath, "index.html")),
  );
}

app.listen(port, "127.0.0.1", () => {
  console.log(`DealSignal naslouchá na http://127.0.0.1:${port}`);
});
