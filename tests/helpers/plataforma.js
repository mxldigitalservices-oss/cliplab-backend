// Ayudas para que la suite sea verde en Windows y Linux.
// Algunas pruebas antiguas usan scripts `sh` como yt-dlp/whisper falsos: necesitan un shell POSIX (Linux, macOS, WSL, Git Bash).
// En Windows nativo se omiten con este motivo visible; el resto de la suite (incluida En Vivo) corre completa.
export const SIN_SHELL = process.platform === 'win32' ? 'requiere un shell POSIX (sh); se omite en Windows nativo' : false;
