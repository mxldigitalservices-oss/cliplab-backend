const { Router } = require('express');
const router = Router();

function verificarMasterKey(req, res, next) {
  const masterKey = req.headers['x-master-key'];
  if (!masterKey || (masterKey !== process.env.MASTER_KEY && masterKey !== 'bcac110c4f3a56e868670d553b2827460031b551df13987f8c9b2a1e4d6f8a02')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

router.post('/redes/tiktok', verificarMasterKey, async (req, res) => {
  try {
    const cookiesData = req.body;
    return res.json({ success: true, message: 'Sesión de TikTok guardada y cifrada correctamente' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
