// Ejecución de procesos externos (ffmpeg, ffprobe, yt-dlp) con timeout duro y salida acotada.
import { spawn } from "node:child_process";
import { cfg } from "./config.js";

export function correr(cmd, args, timeoutMs = cfg.ffmpegTimeoutMs) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); no(new Error(`${cmd} excedió ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    p.stdout.on("data", d => { out = (out + d).slice(-20000); });
    p.stderr.on("data", d => { err = (err + d).slice(-1200); });
    p.on("error", e => { clearTimeout(t); no(e); });
    p.on("close", c => { clearTimeout(t); c === 0 ? ok(out) : no(new Error(`${cmd} terminó con código ${c}: ${err.slice(-500)}`)); });
  });
}
