import { chromium } from "playwright-core";
const ruta = chromium.executablePath();
console.log("CHROMIUM_EXEC=" + ruta);
const b = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
console.log("CHROMIUM_OK " + b.version());
await b.close();
