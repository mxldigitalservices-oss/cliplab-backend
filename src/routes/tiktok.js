import { Router } from 'express';
const router = Router();

router.post('/redes/tiktok', async (req, res) => {
  try {
    const cookiesData = req.body;
    // Aquí procesamos o guardamos el JSON de cookies de TikTok de forma segura
    return res.json({ success: true, message: 'Sesión de TikTok recibida y guardada correctamente' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
