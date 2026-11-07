import fs from "node:fs/promises";
import { asegurarArchivo, borrarArchivo } from "./clips.js";
import { mediaUrl } from "./security.js";

const need = (...k) => { const m = k.filter(x => !process.env[x]); if (m.length) throw new Error("Faltan variables: " + m.join(", ")); };
const caption = c => `${c.clip_titulo}${c.es_parte ? ` (Parte ${c.es_parte}/2)` : ""}\n\n${c.gancho || ""}`.trim();
const json = async (r, who) => { const d = await r.json().catch(() => ({})); if (!r.ok || d.error?.message) throw new Error(`${who}: ${d.error?.message || r.status}`); return d; };

async function youtube(c, file) {
  need("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN");
  const { access_token } = await json(await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: process.env.YT_REFRESH_TOKEN, grant_type: "refresh_token" }) }), "YouTube OAuth");
  const buf = await fs.readFile(file);
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(buf.length), "X-Upload-Content-Type": "video/mp4" },
    body: JSON.stringify({ snippet: { title: (c.clip_titulo + " #Shorts").slice(0, 100), description: caption(c), categoryId: "22" },
      status: { privacyStatus: process.env.YT_PRIVACY || "private", selfDeclaredMadeForKids: false } }) });
  if (!init.ok) throw new Error("YouTube: " + init.status + " " + (await init.text()).slice(0, 200));
  const up = await fetch(init.headers.get("location"), { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: buf });
  return (await json(up, "YouTube upload")).id;
}

async function tiktok(c, file) {   // Sin probar contra la API real.
  need("TIKTOK_ACCESS_TOKEN");
  const buf = await fs.readFile(file), n = buf.length;
  const d = await json(await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", { method: "POST",
    headers: { Authorization: "Bearer " + process.env.TIKTOK_ACCESS_TOKEN, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ post_info: { title: caption(c).slice(0, 150), privacy_level: process.env.TIKTOK_PRIVACY || "SELF_ONLY" },
      source_info: { source: "FILE_UPLOAD", video_size: n, chunk_size: n, total_chunk_count: 1 } }) }), "TikTok");
  const up = await fetch(d.data.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${n - 1}/${n}` }, body: buf });
  if (!up.ok) throw new Error("TikTok upload " + up.status);
  return d.data.publish_id;
}

async function instagram(c) {   // Sin probar. Instagram descarga el video desde una URL firmada de PUBLIC_URL (30 min)
  need("IG_USER_ID", "IG_ACCESS_TOKEN", "PUBLIC_URL");
  const g = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}`, t = process.env.IG_ACCESS_TOKEN, post = (u, b) =>
    fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...b, access_token: t }) });
  const cont = await json(await post(`${g}/${process.env.IG_USER_ID}/media`,
    { media_type: "REELS", video_url: mediaUrl(process.env.PUBLIC_URL.replace(/\/$/, ""), c.token, 1800), caption: caption(c) }), "Instagram");
  for (let i = 0; ; i++) {
    const s = await json(await fetch(`${g}/${cont.id}?fields=status_code&access_token=${t}`), "Instagram");
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || i >= 30) throw new Error("Instagram no pudo procesar el video a tiempo.");
    await new Promise(r => setTimeout(r, 5000));
  }
  return (await json(await post(`${g}/${process.env.IG_USER_ID}/media_publish`, { creation_id: cont.id }), "Instagram")).id;
}

export const PLATAFORMAS = { youtube, tiktok, instagram };

export async function publicar(db, c, plats) {
  const res = {};
  for (const p of plats) {
    try {
      if (c.es_parte === 2) {   // la Parte 2 nunca sale antes que la Parte 1
        const { rows } = await db.query(`SELECT 1 FROM publicaciones pu JOIN clips k ON k.id=pu.clip_id
          WHERE k.serie_id=$1 AND k.es_parte=1 AND pu.plataforma=$2 AND pu.estado='ok' LIMIT 1`, [c.serie_id, p]);
        if (!rows.length) throw new Error("Publica primero la Parte 1 en " + p + ".");
      }
      const id = await PLATAFORMAS[p](c, await asegurarArchivo(db, c));
      await db.query("INSERT INTO publicaciones(clip_id,plataforma,estado,externo_id) VALUES($1,$2,'ok',$3)", [c.id, p, String(id)]);
      res[p] = { ok: true, id };
    } catch (e) {
      await db.query("INSERT INTO publicaciones(clip_id,plataforma,estado,error) VALUES($1,$2,'error',$3)", [c.id, p, e.message.slice(0, 500)]);
      res[p] = { ok: false, error: e.message };
    }
  }
  // Auto-destrucción: solo si TODAS las subidas pedidas fueron exitosas.
  if (plats.length && Object.values(res).every(r => r.ok)) await borrarArchivo(db, c.id);
  return res;
}
