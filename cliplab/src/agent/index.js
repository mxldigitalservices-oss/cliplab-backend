import { cfg } from "../config.js";
import { conSesion, agenteOcupado } from "./browser.js";
import { armarCaption } from "./texto.js";
import * as tiktok from "./tiktok.js";
import * as instagram from "./instagram.js";
import * as facebook from "./facebook.js";

const MODULOS = { tiktok, instagram, facebook };
export { agenteOcupado };

export function publicarEn(plataforma, clip) {
  const caption = armarCaption(clip);
  return conSesion(plataforma, `clip${clip.id}`, (page, ev) =>
    MODULOS[plataforma].publicar(page, { archivo: clip.archivo, caption, real: cfg.publicarReal, ev }));
}

export const probarSesion = plataforma =>
  conSesion(plataforma, "prueba", page => MODULOS[plataforma].probar(page), { guardar: false });
